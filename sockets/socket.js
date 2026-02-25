/*
Socket.IO handlers for InkBattle Game - REFACTORED VERSION
Features:
- Lobby-based settings
- Round phases with timers
- Dynamic points system
- Team vs Team mode
- Entry coins deduction
- Game end with rankings
*/

const { verify } = require("../utils/auth");
const { PHASE_DURATIONS } = require("./gameHelpers");
const { normalizeCountryCode } = require("../utils/countryCode");

const {
	Room,
	RoomParticipant,
	User,
	Message,
	CoinTransaction,
	Theme,
	sequelize,
} = require("../models");
const { getRoomByCode } = require("../utils/roomCache");
const {
	calculateEntryCost,
	calculateGuessReward,
	calculateTimeReduction,
} = require("./gameHelpers");
const {
	startNewRound,
	startDrawingPhase,
	clearRoomTimer,
	handleDrawerLeave,
	handleOwnerLeave,
	checkAndCloseEmptyRoom,
	checkAndEndGameIfInsufficientPlayers,
	getTimersReady,
} = require("./roundPhases");
const { getSocketIdForUser, setSocketForUser, deleteUser, emitToUser } = require("./userSocketMap");
const sdpTransform = require("sdp-transform");
const voiceManager = require("./voiceManager");
const readyState = require("./readyState");
const lobbyIdleTimers = new Map();
// Grace period (ms) before marking participant inactive on disconnect (app background/pause)
const DISCONNECT_GRACE_MS = 90 * 1000;
const disconnectGraceTimers = new Map();

// Join deduplication: one join per (room, user) per socket; TTL fallback (reconnect storms, retries, TCP duplicates)
const JOIN_LOCK_MS = 2000;
/** @type {Map<string, string>} joinLockKey -> socket.id that owns the lock (connection-scoped idempotency) */
const joinLocks = new Map();

function clearDisconnectGraceTimer(roomId, userId) {
	const key = `${roomId}_${userId}`;
	const existing = disconnectGraceTimers.get(key);
	if (existing) {
		clearTimeout(existing);
		disconnectGraceTimers.delete(key);
	}
}

/** Clear resync/canvas state so socket is not stuck (call on leave/disconnect). */
function clearResyncState(socket) {
	socket.isResyncing = false;
	socket.resyncRoomId = undefined;
	socket.canvasRequestedForRoom = undefined;
}

function buildParticipantList(participants, roomId) {
	return participants.map((p) => ({
		id: p.userId,
		name: p.user ? p.user.name : "Guest",
		avatar: p.user ? p.user.avatar : null,
		coins: p.user ? p.user.coins : 0,
		score: p.score,
		team: p.team,
		isDrawer: p.isDrawer,
		socketId: p.socketId,
		hasPaidEntry: p.hasPaidEntry,
		ready: readyState.isReady(roomId, p.userId),
	}));
}

async function startLobbyIdleTimer(io, room) {
	// Only start if the room is still in a pre-game status
	if (room.status === "lobby" || room.status === "waiting") {
		clearLobbyIdleTimer(room.id); // Clear any existing timer

		const timer = setTimeout(async () => {
			const refreshedRoom = await Room.findByPk(room.id);
			if (!refreshedRoom || refreshedRoom.status === "playing") {
				lobbyIdleTimers.delete(room.id);
				return;
			}

			// Resolve owner's current socket right before emit (single source of truth = userSocketMap).
			const ownerId = refreshedRoom.ownerId;
			if (emitToUser(io, ownerId, "lobby_time_exceeded", {
				roomCode: refreshedRoom.code,
				message: `You've been waiting for ${(PHASE_DURATIONS.lobby_timeout / 60).toFixed(2)} minutes. Do you want to continue waiting or exit the room?`,
			})) {
				console.log(
					`🚨 Owner idle timeout exceeded for room ${refreshedRoom.code}. Owner notified.`,
				);
			} else {
				// Owner has no current socket; auto-close the room to clean up.
				await checkAndCloseEmptyRoom(io, refreshedRoom.id);
			}

			lobbyIdleTimers.delete(room.id); // Remove timer reference
		}, PHASE_DURATIONS.lobby_timeout * 1000);

		lobbyIdleTimers.set(room.id, timer);
		console.log(`⏱️ Lobby idle timer started for room ${room.code}.`);
	}
}
function clearLobbyIdleTimer(roomId) {
	if (lobbyIdleTimers.has(roomId)) {
		clearTimeout(lobbyIdleTimers.get(roomId));
		lobbyIdleTimers.delete(roomId);
		console.log(`⏱️ Lobby idle timer cleared for room ID: ${roomId}`);
	}
}

/**
 * Production log: user reconnected into a state where an action SHOULD exist.
 * Correlate with ACTION_CONFIRMED to detect lost emits / bad resume logic.
 * @param {object} socket - joining socket
 * @param {object} room - room with roundPhase, currentDrawerId, etc.
 * @param {string} action - EXPECT_WORD_OPTIONS | EXPECT_CANVAS_SYNC
 * @param {string} recovery - resent | requested | skipped
 * @param {string} [reason] - reason when recovery=skipped (e.g. no_word_options, drawer_socket_not_found)
 */
function logResumeState(socket, room, action, recovery, reason) {
	const userId = socket.user?.id;
	if (userId == null || !room?.code) return;
	const parts = [`[RESUME_CHECK] user=${userId} room=${room.code} action=${action} recovery=${recovery}`];
	if (reason) parts.push(`reason=${reason}`);
	console.log(parts.join(" "));
}

/**
 * Production log: client confirmed they handled the recovery action.
 * Correlate with RESUME_CHECK to detect lost emits.
 */
function logActionConfirmed(socket, roomCode, action) {
	const userId = socket.user?.id;
	if (userId == null) return;
	console.log(`[ACTION_CONFIRMED] user=${userId} room=${roomCode || "?"} action=${action}`);
}

module.exports = function (io) {
	// Authentication middleware
	io.use(async (socket, next) => {
		try {
			const token = socket.handshake.auth?.token;
			console.log(`Receiving Token: ${token}`);
			if (!token) {
				console.log("❌ No token sent");
				return next();
			}

			const payload = verify(token); // may throw
			if (!payload || !payload.id) {
				console.log("❌ Invalid token payload");
				return next();
			}

			const user = await User.findByPk(payload.id);
			if (!user) {
				console.log("❌ No user found for token id", payload.id);
				return next();
			}

			console.log("✅ Authenticated socket:", user.name);

			socket.user = user;
			next();
		} catch (e) {
			console.log("❌ Token verify failed:", e.message);
			return next(); // do NOT crash server
		}
	});

	// O(1) single-session enforcement: one socket per user (disconnect previous when same user connects)
	io.on("connection", (socket) => {
		console.log(
			"✅ Socket connected:",
			socket.id,
			socket.user ? `User: ${socket.user.name}` : "anonymous",
		);

		if (socket.user?.id) {
			const userId = socket.user.id;
			const prevSocketId = getSocketIdForUser(userId);
			if (prevSocketId && prevSocketId !== socket.id) {
				const oldSocket = io.sockets.sockets.get(prevSocketId);
				if (oldSocket) oldSocket.disconnect(true);
			}
			setSocketForUser(userId, socket.id);
			socket.userId = userId;
		}

		// JOIN ROOM
		socket.on("join_room", async ({ roomCode, roomId, team }) => {
			try {
				// No joins until phase timers are restored after server restart (client should retry after server_syncing)
				if (!getTimersReady()) {
					socket.emit("server_syncing");
					return;
				}

				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}

				if (!room) {
					return socket.emit("error", { message: "room_not_found" });
				}

				if (room.status === "inactive") {
					return socket.emit("error", { message: "room_closed" });
				}

				if (!socket.user || !socket.user.id) {
					return socket.emit("error", { message: "not_authenticated" });
				}

				// Deduplicate join: only one socket may join (user+room) at a time; same socket duplicate → block, new socket (reconnect) → allow
				const joinLockKey = `${room.id}_${socket.user.id}`;
				const lockedSocketId = joinLocks.get(joinLockKey);
				if (lockedSocketId != null && lockedSocketId === socket.id) return; // duplicate from same connection
				joinLocks.set(joinLockKey, socket.id);
				setTimeout(() => joinLocks.delete(joinLockKey), JOIN_LOCK_MS);

				// Cache minimal identity on the socket for fast disconnect/reconnect paths
				socket.roomId = room.id;
				socket.roomCode = room.code;
				socket.userId = socket.user.id;

				// --- Check if the user is a REJOINING participant (so we don't reject with room_full after ad/resume) ---
				let existingParticipant = await RoomParticipant.findOne({
					where: { roomId: room.id, userId: socket.user.id },
				});
				// Banned from this room only: cannot re-join this room; can still join other rooms
				if (existingParticipant && existingParticipant.bannedAt) {
					return socket.emit("error", { message: "you_are_banned" });
				}

				const isRejoining =
					existingParticipant && !existingParticipant.isActive;
				// -----------------------------------------------------------

				// Rejoining after being marked inactive (e.g. 90s pause): do not let back in — show Ad + snackbar and exit.
				if (isRejoining) {
					return socket.emit("exited_due_to_inactivity", {
						message: "You were inactive for more than 90 seconds. Exited from room.",
					});
				}

				// Only perform the room_full check for NEW players (no existing participant).
				// Existing participant (e.g. reconnecting or joined via HTTP first) should not be rejected.
				// IMPORTANT: Only socket.emit("error", "room_full") — never broadcast to room; only the joining socket should get it.
				if (!existingParticipant) {
					await room.reload(); // Re-fetch to get latest maxPlayers (e.g. host just changed it)
					const activeParticipants = await RoomParticipant.count({
						where: { roomId: room.id, isActive: true },
					});
					console.log(
						`Active participants: ${activeParticipants}--- ${room.maxPlayers}`,
					);
					if (activeParticipants >= room.maxPlayers) {
						return socket.emit("error", {
							message: "room_full",
							details: `Room is full. Max players: ${room.maxPlayers}`,
						});
					}
				}

				// Idempotency: same socket already in this room — send room state to client only, no broadcasts
				const alreadyInRoom =
					existingParticipant &&
					existingParticipant.isActive &&
					existingParticipant.socketId === socket.id;
				if (alreadyInRoom) {
					socket.join(room.code);
					socket.roomId = room.id;
					socket.roomCode = room.code;
					socket.userId = socket.user.id;
					socket.currentRoom = room.code;
					await room.reload();
					const participants = await RoomParticipant.findAll({
						where: { roomId: room.id, isActive: true },
						include: [
							{
								model: User,
								as: "user",
								attributes: ["id", "name", "avatar", "coins"],
							},
						],
					});
					const participantList = buildParticipantList(participants, room.id);
					await startLobbyIdleTimer(io, room);
					const roundRemainingTime = room.roundPhaseEndTime
						? Math.max(
								0,
								Math.ceil((room.roundPhaseEndTime - Date.now()) / 1000),
							)
						: room.roundRemainingTime;
					socket.emit("room_joined", {
						room: {
							id: room.id,
							code: room.code,
							name: room.name,
							status: room.status,
							gameMode: room.gameMode,
							category: room.category,
							language: room.language,
							script: room.script,
							country: room.country,
							voiceEnabled: room.voiceEnabled,
							currentRound: room.currentRound,
							maxPlayers: room.maxPlayers,
							entryPoints: room.entryPoints,
							targetPoints: room.targetPoints,
							isPublic: room.isPublic,
							ownerId: room.ownerId,
							roundPhase: room.roundPhase,
							roundRemainingTime,
							roundPhaseEndTime: room.roundPhaseEndTime ? room.roundPhaseEndTime.getTime() : undefined,
							roundDuration: PHASE_DURATIONS[room.roundPhase],
						},
						participants: participantList,
						isResuming: false,
					});
					joinLocks.delete(joinLockKey); // release lock on success; TTL is fallback only
					// Sync state to this socket only: canvas if in drawing phase (no room/timer changes)
					if (room.status === "playing" && room.roundPhase === "drawing") {
						const currentDrawerId = room.currentDrawerId;
						const resumingSocketId = socket.id;
						// METHOD 3: If joiner is the drawer, use socket.id. Else resolve from userSocketMap (METHOD 1+2).
						const drawerSocketId = socket.user?.id === currentDrawerId
							? socket.id
							: getSocketIdForUser(currentDrawerId);
						if (drawerSocketId) {
							const alreadyRequested = socket.canvasRequestedForRoom === room.id;
							if (!alreadyRequested) {
								socket.canvasRequestedForRoom = room.id;
								socket.isResyncing = true;
								socket.resyncRoomId = room.id;
								io.to(drawerSocketId).emit("request_canvas_data", {
									roomCode: room.code,
									targetSocketId: resumingSocketId,
									targetUserId: socket.user?.id,
								});
							}
							if (currentDrawerId === socket.user?.id) {
								for (const p of participantList) {
									if (p.id !== currentDrawerId) {
										const targetSocketId = getSocketIdForUser(p.id);
										if (targetSocketId) {
											io.to(drawerSocketId).emit("request_canvas_data", {
												roomCode: room.code,
												targetSocketId,
												targetUserId: p.id,
											});
										}
									}
								}
							}
						}
					}
					// Do NOT call resumePhaseTimerIfNeeded here — idempotent path must not restart timers or modify room state
					return;
				}

				socket.join(room.code);
				socket.currentRoom = room.code;

				// Reactivate room if it was inactive (This logic is fine for resume)
				if (room.status === "inactive") {
					await Room.update(
						{ status: room.isPublic ? "waiting" : "lobby" },
						{ where: { id: room.id } },
					);
					room.status = room.isPublic ? "waiting" : "lobby";
					console.log(
						`🔄 Room ${room.id} (${room.name}) reactivated from inactive state`,
					);
				}

				let isNewParticipant = false; // Add this flag for clean logging/DB insertion

				if (socket.user) {
					if (existingParticipant) {
						// Cancel any pending disconnect-grace timer (user rejoined from background)
						clearDisconnectGraceTimer(room.id, socket.user.id);

						// --- RESUME LOGIC: Update participant status and socket ID ---
						await RoomParticipant.update(
							{ socketId: socket.id, isActive: true },
							{ where: { roomId: room.id, userId: socket.user.id } },
						);
						console.log(
							`✅ User ${socket.user.name} RESUMED game in room ${room.code}`,
						);
					} else {
						// NEW PLAYER: enforce capacity with a DB transaction + lock to avoid race conditions.
						try {
							await sequelize.transaction(async (t) => {
								// Lock the room row and get the latest maxPlayers
								const freshRoom = await Room.findByPk(room.id, {
									transaction: t,
									lock: t.LOCK.UPDATE,
								});
								const countNow = await RoomParticipant.count({
									where: { roomId: room.id, isActive: true },
									transaction: t,
									lock: t.LOCK.UPDATE,
								});
								if (!freshRoom || countNow >= freshRoom.maxPlayers) {
									const err = new Error("ROOM_FULL_CONCURRENT");
									err.maxPlayers = freshRoom ? freshRoom.maxPlayers : room.maxPlayers;
									throw err;
								}

								isNewParticipant = true;
								const basePayload = {
									roomId: room.id,
									userId: socket.user.id,
									socketId: socket.id,
									isActive: true,
								};

								if (room.gameMode !== "1v1") {
									await RoomParticipant.create(
										{ ...basePayload, team: "blue" },
										{ transaction: t },
									);
								} else {
									await RoomParticipant.create(basePayload, { transaction: t });
								}
							});
						} catch (err) {
							if (err && err.message === "ROOM_FULL_CONCURRENT") {
								socket.leave(room.code);
								return socket.emit("error", {
									message: "room_full",
									details: `Room is full. Max players: ${err.maxPlayers || room.maxPlayers}`,
								});
							}
							// Unexpected DB error: rethrow to outer catch
							throw err;
						}
					}
				}
				if (team) {
					await RoomParticipant.update(
						{ team }, //  values first
						{
							where: {
								userId: socket.user.id,
								roomId: room.id,
							},
						}
					);
				}


				// --- Fetch ALL participants (including the newly resumed/active one) ---
				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [
						{
							model: User,
							as: "user",
							attributes: ["id", "name", "avatar", "coins"],
						},
					],
				});
				const participantList = buildParticipantList(participants, room.id);
				await startLobbyIdleTimer(io, room);
				// --------------------------------------------------------------------------

				// --- Emit room_joined to the rejoining client, including isResuming flag ---
				// Compute roundRemainingTime from roundPhaseEndTime when present (no longer updated per second in DB)
				const roundRemainingTime = room.roundPhaseEndTime
					? Math.max(0, Math.ceil((room.roundPhaseEndTime - Date.now()) / 1000))
					: room.roundRemainingTime;
				socket.emit("room_joined", {
					room: {
						id: room.id,
						code: room.code,
						name: room.name,
						status: room.status,
						gameMode: room.gameMode,
						category: room.category,
						language: room.language,
						script: room.script,
						country: room.country,
						voiceEnabled: room.voiceEnabled,
						currentRound: room.currentRound,
						maxPlayers: room.maxPlayers,
						entryPoints: room.entryPoints,
						targetPoints: room.targetPoints,
						isPublic: room.isPublic,
						ownerId: room.ownerId,
						// The resume feature relies on the client receiving these:
						roundPhase: room.roundPhase,
						roundRemainingTime,
						roundPhaseEndTime: room.roundPhaseEndTime ? room.roundPhaseEndTime.getTime() : undefined,
						roundDuration: PHASE_DURATIONS[room.roundPhase],
						// The entire room object serves as the Game State for the client.
					},
					participants: participantList,
					isResuming: isRejoining, // <--- NEW: Flag for the client
				});
				joinLocks.delete(joinLockKey); // release lock on success; TTL is fallback only
				// --------------------------------------------------------------------------

				// Broadcast updated participant list to ALL room members
				io.to(room.code).emit("room_participants", {
					participants: participantList,
				});

				// Notify others that a player joined/rejoined
				socket.to(room.code).emit("player_joined", {
					userName: socket.user ? socket.user.name : "Guest",
					userId: socket.user ? socket.user.id : null,
					isRejoining: isRejoining, // <--- NEW: Notify others
				});

				// Log for clarity
				if (!isRejoining && !isNewParticipant) {
					console.log(
						`👤 User ${socket.user ? socket.user.name : "Guest"} joined room ${room.code}`,
					);
				}

				// NOTE: Request drawing history only when phase is "drawing" (no canvas in selecting_drawer/choosing_word).
				// Reconnect = sync only: do NOT call resumePhaseTimerIfNeeded here (that clears and re-broadcasts phase to whole room).
				// Timers are restored only on server startup via rebuildTimersOnStartup.
				let resumeWordOptionsSent = false;
				let resumeCanvasRequested = false;
				let resumeCanvasSkippedReason = null;
				if (room.status === "playing") {
					// Only request canvas when we are actually in the drawing phase (canvas exists).
					if (room.roundPhase === "drawing") {
						const currentDrawerId = room.currentDrawerId;
						const resumingSocketId = socket.id;
						// METHOD 3: If joiner is the drawer, use socket.id. Else resolve from userSocketMap (METHOD 1+2).
						const drawerSocketId = socket.user?.id === currentDrawerId
							? socket.id
							: getSocketIdForUser(currentDrawerId);
						if (drawerSocketId) {
							// One canvas request per resume: skip if we already requested for this socket in this room
							const alreadyRequested = socket.canvasRequestedForRoom === room.id;
							if (!alreadyRequested) {
								socket.canvasRequestedForRoom = room.id;
								socket.isResyncing = true;
								socket.resyncRoomId = room.id;
								io.to(drawerSocketId).emit("request_canvas_data", {
									roomCode: room.code,
									targetSocketId: resumingSocketId,
									targetUserId: socket.user?.id,
								});
								resumeCanvasRequested = true;
								const drawerName = participantList.find((p) => p.id === currentDrawerId)?.name ?? "drawer";
								console.log(
									`📡 Requested canvas data from drawer ${drawerName} for resuming user ${socket.user?.name}`,
								);
							} else {
								resumeCanvasRequested = true; // already requested earlier this session
							}

							// When the drawer rejoins, request canvas for all other participants (once per target). METHOD 3: drawer socket = socket.id.
							if (currentDrawerId === socket.user?.id) {
								for (const p of participantList) {
									if (p.id !== currentDrawerId) {
										const targetSocketId = getSocketIdForUser(p.id);
										if (targetSocketId) {
											io.to(socket.id).emit("request_canvas_data", {
												roomCode: room.code,
												targetSocketId,
												targetUserId: p.id,
											});
											resumeCanvasRequested = true;
											console.log(
												`📡 Requested canvas from drawer for other participant ${p.name} (${targetSocketId})`,
											);
										}
									}
								}
							}
						} else {
							resumeCanvasSkippedReason = "drawer_socket_not_found";
							console.warn(
								`⚠️ Room ${room.code} is playing (drawing), but drawer socket not found.`,
							);
						}
					}

					// Re-send word_options if drawer rejoins during choosing_word
					if (
						room.roundPhase === "choosing_word" &&
						room.currentDrawerId === socket.user.id &&
						Array.isArray(room.currentWordOptions)
					) {
						socket.emit("word_options", {
						words: room.currentWordOptions,
						duration: Math.max(
							0,
							Math.ceil((room.roundPhaseEndTime - Date.now()) / 1000)
						),
						});
						resumeWordOptionsSent = true;
					}

					// Production log: detect "state says action should exist" vs "recovery sent or skipped"
					if (room.roundPhase === "choosing_word" && room.currentDrawerId === socket.user?.id) {
						logResumeState(
							socket,
							room,
							"EXPECT_WORD_OPTIONS",
							resumeWordOptionsSent ? "resent" : "skipped",
							resumeWordOptionsSent ? undefined : "no_word_options",
						);
					}
					if (room.roundPhase === "drawing") {
						logResumeState(
							socket,
							room,
							"EXPECT_CANVAS_SYNC",
							resumeCanvasRequested ? "requested" : "skipped",
							resumeCanvasSkippedReason ?? undefined,
						);
					}
				}
			} catch (e) {
				console.error("Join room error:", e);
				socket.emit("error", { message: "join_room_failed" });
			}
		});
		// Resume Feature
		socket.on(
			"send_canvas_data",
			async ({ roomCode, targetSocketId, targetUserId, history, remainingTime, lastSequence }) => {
				console.log("Received canvas data:", history);
				// 1. Check if the room is valid (optional but good security)
				const room = await getRoomByCode(roomCode);
				if (!room) return socket.emit("error", { message: "room_not_found" });

				// 2. Build room payload with roundPhaseEndTime (ms) and roundDuration so client stays in sync (same shape as room_joined).
				const roomPlain = typeof room.toJSON === "function" ? room.toJSON() : { ...room };
				const roomPayload = {
					...roomPlain,
					roundPhaseEndTime: room.roundPhaseEndTime ? room.roundPhaseEndTime.getTime() : undefined,
					roundDuration: PHASE_DURATIONS[room.roundPhase],
				};

				// lastSequence: client must send so resuming client can ignore drawing_data with seq <= lastSequence until resync done
				const lastSeq = lastSequence != null && Number.isFinite(Number(lastSequence)) ? Number(lastSequence) : 0;

				const payload = {
					roomCode: roomCode,
					history: history,
					room: roomPayload,
					remainingTime: remainingTime,
					lastSequence: lastSeq,
				};
				// 3. Emit to target's current socket (METHOD 1+2: use targetUserId when client sends it so reconnect is handled)
				if (targetUserId && emitToUser(io, targetUserId, "canvas_resume", payload)) {
					console.log(
						`➡️ Forwarded canvas data to resuming user (userId ${targetUserId}, lastSequence: ${lastSeq})`,
					);
				} else if (targetSocketId) {
					io.to(targetSocketId).emit("canvas_resume", payload);
					console.log(
						`➡️ Forwarded canvas data to resuming user: ${targetSocketId} (lastSequence: ${lastSeq})`,
					);
				}
			},
		);

		// Client signals resync done so server stops skipping drawing_data for this socket
		socket.on("resync_done", () => {
			socket.isResyncing = false;
			logActionConfirmed(socket, socket.roomCode, "CANVAS_SYNC_HANDLED");
			socket.resyncRoomId = undefined;
		});

		socket.on("update_settings", async ({ roomId, settings }) => {
			const VOICE_CHAT_COST = 50;

			let successEmitted = false;
			try {
				if (roomId == null || settings == null || typeof settings !== "object") {
					return socket.emit("error", {
						message: "update_settings_failed",
						details: "roomId and settings object are required",
					});
				}
				const room = await Room.findByPk(roomId);
				if (!room) return socket.emit("error", { message: "room_not_found" });

				// Basic authorization checks
				console.log(socket.user);
				if (room.ownerId !== socket.user?.id) {
					return socket.emit("error", { message: "only_owner_can_update" });
				}

				if (room.status !== "lobby" && room.status !== "waiting") {
					return socket.emit("error", {
						message: "cannot_update_after_game_started",
					});
				}

				// --- VOICE CHAT FEE LOGIC ---
				if (
					settings.voiceEnabled !== undefined &&
					settings.voiceEnabled === true &&
					room.voiceEnabled === false
				) {
					// 1. Fetch all active participants and their User models
					const participants = await RoomParticipant.findAll({
						where: { roomId: room.id, isActive: true },
						include: [{ model: User, as: "user" }],
					});

					const insufficientFundsUsers = [];
					const usersToCharge = [];

					// 2. Check Balances for all users
					for (const participant of participants) {
						if (!participant.user) continue;

						if (participant.user.coins < VOICE_CHAT_COST) {
							insufficientFundsUsers.push(participant.user.name);
						} else {
							usersToCharge.push(participant.user);
						}
					}

					// 3. Handle Insufficient Funds (Block and Notify All)
					if (insufficientFundsUsers.length > 0) {
						const names = insufficientFundsUsers.join(", ");
						const errorMessage = `Voice chat requires ${VOICE_CHAT_COST} coins from everyone. Users lacking funds: ${names}.`;

						// Broadcast error to everyone in the room (not just the owner)
						io.to(room.code).emit("error", {
							message: "insufficient_coins",
							details: errorMessage,
							usersAffected: insufficientFundsUsers,
						});

						// Do NOT update room.voiceEnabled and return
						return;
					}

					// 4. Charge Users and Update Database (Transaction Recommended, but simplified here)
					const chargePromises = usersToCharge.map((user) => {
						user.coins -= VOICE_CHAT_COST;
						return user.save();
					});
					await Promise.all(chargePromises);

					room.voiceEnabled = settings.voiceEnabled;

					io.to(room.code).emit("error", {
						message: `Voice chat enabled! ${VOICE_CHAT_COST} coins charged from all active participants.`,
					});
				} else if (
					settings.voiceEnabled !== undefined &&
					settings.voiceEnabled === false
				) {
					room.voiceEnabled = settings.voiceEnabled;
				}
				if (settings.gameMode !== undefined) room.gameMode = settings.gameMode;
				if (settings.language !== undefined) room.language = settings.language;
				if (settings.script !== undefined) room.script = settings.script;
				if (settings.country !== undefined) {
					// Normalize country to ISO-2 code for consistent storage
					const normalizedCountry = normalizeCountryCode(settings.country);
					if (normalizedCountry) {
						room.country = normalizedCountry;
					}
				}
				if (settings.category !== undefined) {
					//room.category = settings.category;
					//const theme = await Theme.findOne({
					//where: { title: settings.category },
					//});
					// room.themeId = theme ? theme.id : null;
					// Handle category as array or string (for backward compatibility)
					if (Array.isArray(settings.category)) {
						room.category = settings.category;
						// For multiple categories, we don't set a single themeId
						// The wordSelector will handle multiple categories
						room.themeId = null;
					} else if (typeof settings.category === 'string') {
						// Backward compatibility: single category as string
						room.category = [settings.category];
						const theme = await Theme.findOne({
							where: { title: settings.category },
						});
						room.themeId = theme ? theme.id : null;
					} else {
						room.category = [];
						room.themeId = null;
					}
				}
				if (settings.entryPoints !== undefined) {
					if (settings.voiceEnabled === true)
						room.entryPoints = settings.entryPoints + VOICE_CHAT_COST;
					else room.entryPoints = settings.entryPoints;
				}
				if (settings.targetPoints !== undefined)
					room.targetPoints = settings.targetPoints;

				if (settings.isPublic !== undefined) {
					room.isPublic = settings.isPublic;
					if (settings.isPublic === true && room.status === "lobby") {
						room.status = "waiting";
					}
					if (settings.isPublic === false && room.status === "waiting") {
						room.status = "lobby";
					}
				}
				if (settings.maxPlayers !== undefined) {
					const parsedMax =
						typeof settings.maxPlayers === "number"
							? settings.maxPlayers
							: parseInt(settings.maxPlayers, 10);
					// Validate and clamp maxPlayers to a safe range (2–15)
					if (!Number.isFinite(parsedMax) || parsedMax < 2 || parsedMax > 15) {
						return socket.emit("error", {
							message: "invalid_max_players",
							details: "maxPlayers must be an integer between 2 and 15",
						});
					}
					console.log(
						`🔵 BACKEND: Updating maxPlayers from ${room.maxPlayers} to ${parsedMax}`,
					);
					room.maxPlayers = parsedMax;
				}

				await room.save();
				let data = {
					gameMode: room.gameMode,
					language: room.language,
					script: room.script,
					country: room.country,
					category: room.category,
					entryPoints: room.entryPoints,
					targetPoints: room.targetPoints,
					voiceEnabled: room.voiceEnabled,
					isPublic: room.isPublic,
					maxPlayers: room.maxPlayers,
					status: room.status,
				};
				console.log(
					`🟢 BACKEND: Emitting settings_updated to room ${room.code} with maxPlayers: ${data.maxPlayers}`,
				);
				io.to(room.code).emit("settings_updated", data);
				successEmitted = true;
				console.log(
					`⚙️ Room ${room.id} settings updated  \n${JSON.stringify(data)}`,
				);
			} catch (e) {
				console.error("Update settings error:", e?.message ?? e);
				if (e?.stack) console.error("Update settings stack:", e.stack);
				// Only tell the client "update failed" if we never emitted settings_updated (avoids false error when update actually succeeded)
				if (!successEmitted) {
					socket.emit("error", {
						message: "update_settings_failed",
						details: e?.message || (typeof e === "string" ? e : "Unknown error"),
					});
				}
			}
		});

		// SELECT TEAM
		socket.on("select_team", async ({ roomId, team }) => {
			try {
				if (!team || (team !== "orange" && team !== "blue")) {
					return socket.emit("error", { message: "invalid_team" });
				}

				// Reload room to get latest gameMode
				const room = await Room.findByPk(roomId);
				if (!room) return socket.emit("error", { message: "room_not_found" });

				// Allow team changes in lobby and waiting status (before game starts)
				if (room.status !== "lobby" && room.status !== "waiting") {
					return socket.emit("error", {
						message: "cannot_change_team_after_game_started",
					});
				}

				// Check if game mode supports team selection
				if (room.gameMode !== "team" && room.gameMode !== "team_vs_team") {
					return socket.emit("error", {
						message: "not_team_mode",
						details: `Team selection is only available in team mode. Current mode: ${room.gameMode || "unknown"}`,
					});
				}

				const participant = await RoomParticipant.findOne({
					where: { roomId: room.id, userId: socket.user.id },
				});

				if (!participant) {
					return socket.emit("error", { message: "not_in_room" });
				}

				participant.team = team;
				await participant.save();

				// Reload participant with user info for logging
				await participant.reload({ include: [{ model: User, as: "user" }] });

				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [
						{
							model: User,
							as: "user",
							attributes: ["id", "name", "avatar", "coins"],
						},
					],
				});

				console.log(
					`👥 User ${participant.user?.name || socket.user?.name || "Unknown"} selected team ${team}`,
				);

				io.to(room.code).emit("room_participants", {
					participants: buildParticipantList(participants, room.id),
				});

				console.log(`👥 User ${socket.user.name} selected team ${team}`);
			} catch (e) {
				console.error("Select team error:", e);
				socket.emit("error", { message: "select_team_failed" });
			}
		});

		socket.on("set_ready", async ({ roomCode, roomId }) => {
			try {
				if (!socket.user || !socket.user.id) return socket.emit("error", { message: "not_authenticated" });
				let room;
				if (roomCode) room = await getRoomByCode(roomCode);
				else if (roomId) room = await Room.findByPk(roomId);
				if (!room) return socket.emit("error", { message: "room_not_found" });
				if (room.status !== "lobby" && room.status !== "waiting") return;
				readyState.setReady(room.id, socket.user.id);
				// Broadcast updated participant list with ready flags
				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [{ model: User, as: "user", attributes: ["id", "name", "avatar", "coins"] }],
				});
				io.to(room.code).emit("room_participants", {
					participants: buildParticipantList(participants, room.id),
				});
			} catch (e) {
				console.error("Set ready error:", e);
			}
		});

		socket.on("set_not_ready", async ({ roomCode, roomId }) => {
			try {
				if (!socket.user || !socket.user.id) return socket.emit("error", { message: "not_authenticated" });
				let room;
				if (roomCode) room = await getRoomByCode(roomCode);
				else if (roomId) room = await Room.findByPk(roomId);
				if (!room) return socket.emit("error", { message: "room_not_found" });
				if (room.status !== "lobby" && room.status !== "waiting") return;
				readyState.removeReady(room.id, socket.user.id);
				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [{ model: User, as: "user", attributes: ["id", "name", "avatar", "coins"] }],
				});
				io.to(room.code).emit("room_participants", {
					participants: buildParticipantList(participants, room.id),
				});
			} catch (e) {
				console.error("Set not ready error:", e);
			}
		});

		socket.on("remove_participant", async ({ roomCode, roomId, userId: targetUserId }) => {
			try {
				if (!socket.user || !socket.user.id) return socket.emit("error", { message: "not_authenticated" });
				let room;
				if (roomCode) room = await getRoomByCode(roomCode);
				else if (roomId) room = await Room.findByPk(roomId);
				if (!room) return socket.emit("error", { message: "room_not_found" });
				if (room.ownerId !== socket.user.id) {
					return socket.emit("error", { message: "only_owner_can_remove" });
				}
				// Safety: owner cannot remove themselves via this path (would leave room ownerless)
				if (targetUserId === socket.user.id) {
					return socket.emit("error", { message: "cannot_remove_self" });
				}
				if (room.status === "playing") return socket.emit("error", { message: "cannot_remove_during_game" });
				await RoomParticipant.update(
					{ isActive: false, socketId: null },
					{ where: { roomId: room.id, userId: targetUserId } },
				);
				readyState.removeReady(room.id, targetUserId);
				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [{ model: User, as: "user", attributes: ["id", "name", "avatar", "coins"] }],
				});
				io.to(room.code).emit("room_participants", {
					participants: buildParticipantList(participants, room.id),
				});
				io.to(room.code).emit("player_removed", {
					userId: targetUserId,
					removedBy: socket.user.id,
				});
			} catch (e) {
				console.error("Remove participant error:", e);
				socket.emit("error", { message: "remove_participant_failed" });
			}
		});

		socket.on("continue_waiting", async ({ roomId }) => {
			try {
				const room = await Room.findByPk(roomId);
				if (!room) return;

				// Ensure only the owner can reset the timer
				if (room.ownerId !== socket.user?.id) {
					return socket.emit("error", {
						message: "only_owner_can_reset_timer",
					});
				}
				await startLobbyIdleTimer(io, room);
				// Reset the lobby timeout timer
				// await startLobbyTimeout(io, room);

				console.log(
					`⏱️ Owner ${socket.user.name} chose to continue waiting. Timer reset for room ${room.code}.`,
				);
			} catch (e) {
				console.error("Continue waiting error:", e);
			}
		});
		// START GAME
		socket.on("start_game", async ({ roomCode, roomId }) => {
			try {
				console.log(
					`🎮 Start game request from socket ${socket.id}, user: ${socket.user?.id}, roomId: ${roomId}, roomCode: ${roomCode}`,
				);

				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}
				if (!room) {
					console.log(`❌ Room not found: ${roomId || roomCode}`);
					socket.emit("error", { message: "room_not_found" });
					// Notify all participants who might still be in this room so they leave
					if (roomId != null) {
						try {
							const participants = await RoomParticipant.findAll({
								where: { roomId, isActive: true },
							});
							for (const p of participants) {
								if (p.userId) emitToUser(io, p.userId, "error", { message: "room_not_found" });
							}
						} catch (e) {
							console.warn("Could not notify participants of missing room:", e?.message);
						}
					}
					return;
				}
				clearLobbyIdleTimer(room.id); // Game is starting, clear the waiting timer

				console.log(
					`🏠 Room found: ${room.id}, owner: ${room.ownerId}, current user: ${socket.user?.id}, status: ${room.status}`,
				);

				if (!socket.user || !socket.user.id) {
					console.log(`❌ User not authenticated`);
					return socket.emit("error", { message: "not_authenticated" });
				}

				if (room.ownerId !== socket.user.id) {
					console.log(
						`❌ User ${socket.user.id} is not owner (owner is ${room.ownerId})`,
					);
					return socket.emit("error", { message: "only_owner_can_start" });
				}

				// Allow starting game from both lobby and waiting status
				if (room.status !== "lobby" && room.status !== "waiting") {
					console.log(`❌ Game already started, status: ${room.status}`);
					return socket.emit("error", { message: "game_already_started" });
				}

				const participants = await RoomParticipant.findAll({
					where: { roomId: room.id, isActive: true },
					include: [{ model: User, as: "user" }],
				});

				if (participants.length < 2) {
					return socket.emit("error", { message: "not_enough_players" });
				}

				// All participants except host must have tapped Ready before host can start (host has start power, no "Tap when ready")
				const nonOwnerIds = participants
					.filter((p) => p.userId !== room.ownerId)
					.map((p) => p.userId);
				if (nonOwnerIds.length > 0 && !readyState.areAllReady(room.id, nonOwnerIds)) {
					return socket.emit("error", {
						message: "not_all_ready",
						details: "All players must tap Ready before the host can start.",
					});
				}

				readyState.clearRoom(room.id); // Clear ready state when game starts

				// For team mode, require at least 2 players in BOTH teams before entering game arena
				if (room.gameMode === "team_vs_team") {
					const orangeCount = participants.filter(
						(p) => p.team === "orange",
					).length;
					const blueCount = participants.filter(
						(p) => p.team === "blue",
					).length;

					if (orangeCount < 2 || blueCount < 2) {
						return socket.emit("error", {
							message: "both_teams_need_players",
							details: "Each team needs at least 2 players to start the game",
						});
					}
				}

				const entryCost = calculateEntryCost(
					room.entryPoints,
					room.voiceEnabled,
				);

				// Deduct entry coins only from participants who have not yet paid (exactly once per game)
				for (const participant of participants) {
					const user = await User.findByPk(participant.userId);
					if (!user) continue;

					if (participant.hasPaidEntry) {
						continue;
					}

					if (user.coins < entryCost) {
						return socket.emit("error", {
							message: "insufficient_coins",
							details: `${user.name} needs ${entryCost} coins to play`,
						});
					}

					user.coins -= entryCost;
					await user.save();

					await CoinTransaction.create({
						userId: user.id,
						amount: -entryCost,
						reason: "game_entry",
					});

					participant.hasPaidEntry = true;
					await participant.save();

					console.log(`💰 Deducted ${entryCost} coins from ${user.name}`);
				}

				room.status = "playing";
				room.currentRound = 1;
				room.drawnUserIds = []; // Reset drawer rotation for new game
				// Reset phase and drawer state so no leftover from previous game (second game start guard)
				room.roundPhase = null;
				room.currentDrawerId = null;
				room.currentWord = null;
				room.currentWordOptions = null;
				room.roundPhaseEndTime = null;
				room.roundRemainingTime = null;
				await room.save();

				io.to(room.code).emit("game_started", {
					room: {
						status: room.status,
						entryCost: entryCost,
					},
				});

				console.log(`🎮 Game started in room ${room.code}`);

				await startNewRound(io, room);
			} catch (e) {
				console.error("Start game error:", e);
				socket.emit("error", {
					message: "start_game_failed",
					details: e.message,
				});
			}
		});

		// CHOOSE WORD
		socket.on("choose_word", async ({ roomId, word }) => {
			try {
				const room = await Room.findByPk(roomId);
				if (!room) return;

				if (room.currentDrawerId !== socket.user?.id) {
					return socket.emit("error", { message: "not_your_turn" });
				}

				if (room.roundPhase !== "choosing_word") {
					return socket.emit("error", { message: "wrong_phase" });
				}

				if (
					!room.currentWordOptions ||
					!room.currentWordOptions.includes(word)
				) {
					return socket.emit("error", { message: "invalid_word_choice" });
				}

				room.currentWord = word;
				room.currentWordOptions = null;
				await room.save();

				console.log(`📝 Drawer chose word: ${word}`);
				logActionConfirmed(socket, room.code, "WORD_OPTIONS_HANDLED");
				await RoomParticipant.update(
					{ eliminationCount: 3 },
					{ where: { roomId: room.id, userId: socket.user.id } }
				);
				await startDrawingPhase(io, room);
			} catch (e) {
				console.error("Choose word error:", e);
			}
		});

		// DRAWING DATA
		socket.on("drawing_data", async ({ roomCode, roomId, strokes, isFinished, canvasVersion, sequence }) => {
			try {
				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}
				if (room && room.roundPhase === "drawing") {
					const seqNum = sequence ?? 0;
					const payload = {
						strokes,
						isFinished: isFinished ?? true,
						canvasVersion: canvasVersion ?? 0,
						sequence: seqNum,
						from: socket.id,
					};
					// Skip resyncing sockets so they only get snapshot + events after resync_done (avoids half-snapshot / half-live)
					const socketsInRoom = await io.in(room.code).fetchSockets();
					for (const s of socketsInRoom) {
						if (!s.isResyncing) s.emit("drawing_data", payload);
					}
					socket.emit("drawing_ack", {
						sequence: seqNum,
						timestamp: Date.now()
					});
					console.log(`🎨 Drawing data broadcasted to room ${room.code} (v${canvasVersion ?? 0}, seq: ${seqNum}, finished: ${isFinished ?? true})`);
				} else {
					console.log(
						`⚠️ Drawing data ignored - room phase: ${room?.roundPhase}, room: ${room?.code}`,
					);
					// Re-sync client: emit current phase so they leave drawing UI and match server state
					if (room?.code && room?.roundPhase) {
						const phaseEndTimeMs = room.roundPhaseEndTime
							? (room.roundPhaseEndTime.getTime ? room.roundPhaseEndTime.getTime() : Number(room.roundPhaseEndTime))
							: Date.now() + 60000;
						// duration = full phase duration (for progress bar), not remaining time
						const phaseDuration = (PHASE_DURATIONS[room.roundPhase] ?? room.roundRemainingTime ?? 60);
						console.log("phase_change", {
							phase: room.roundPhase,
							duration: phaseDuration,
							phaseEndTime: phaseEndTimeMs,
							round: room.currentRound,
						});
						
						socket.emit("phase_change", {
							phase: room.roundPhase,
							duration: phaseDuration,
							phaseEndTime: phaseEndTimeMs,
							round: room.currentRound,
						});
					}
				}
			} catch (e) {
				console.error("Drawing data error:", e);
			}
		});

		socket.on('drawer_earned_points', async ({ roomId }) => {
			try {
				const room = await Room.findByPk(roomId);
				if (!room) return;

				if (room.currentDrawerId !== socket.user?.id) {
					console.warn(`⚠️ Suspicious: Non-drawer ${socket.user?.name} tried to award points.`);
					return;
				}

				const participant = await RoomParticipant.findOne({
					where: { roomId: room.id, userId: socket.user.id },
				});
				if (!participant) return;

				// Drawer points are already applied in endDrawingPhase; just re-broadcast current score
				io.to(room.code).emit('score_update', {
					userId: participant.userId,
					score: participant.score,
				});
			} catch (e) {
				console.error("Error syncing drawer score:", e);
			}
		});
		// CLEAR CANVAS
		socket.on("clear_canvas", async ({ roomCode, roomId, canvasVersion }) => {
			try {
				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}
				if (room) {
					const newVersion = (canvasVersion ?? 0) + 1;
					io.to(room.code).emit("canvas_cleared", {
						by: socket.user ? socket.user.name : "Someone",
						canvasVersion: newVersion,
					});
					console.log(`🧹 Canvas cleared in room ${room.code}, new version: ${newVersion}`);
				}
			} catch (e) {
				console.error("Clear canvas error:", e);
			}
		});

		// CHAT MESSAGE
		socket.on("chat_message", async ({ roomCode, roomId, content, avatar }) => {
			console.log(avatar);
			try {
				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}
				if (!room) return;

				const userId = socket.user ? socket.user.id : null;
				const msg = await Message.create({
					roomId: room.id,
					userId,
					content,
					type: "text",
				});

				let user = { id: null, name: "Guest", avatar: avatar };
				if (userId) {
					const dbUser = await User.findByPk(userId);
					// Fetch participant to get the team for this specific room
					const participant = await RoomParticipant.findOne({
						where: { roomId: room.id, userId: userId },
					});

					if (dbUser) {
						user = {
							id: dbUser.id,
							name: dbUser.name,
							avatar: dbUser.avatar,
							team: participant ? participant.team : dbUser.team // Prioritize room participant team
						};
					}
				}

				io.to(room.code).emit("chat_message", {
					id: msg.id,
					content: msg.content,
					user,
					createdAt: msg.createdAt,
					type: "text",
				});
			} catch (e) {
				console.error("Chat message error:", e);
			}
		});

		// SUBMIT GUESS
		socket.on("submit_guess", async ({ roomCode, roomId, guess }) => {
			try {
				let room;
				// 1. Find Room
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}

				if (!room) {
					return socket.emit("guess_result", {
						ok: false,
						message: "room_not_found",
					});
				}

				// 2. Initial Checks (Phase, Word, Authentication)
				if (room.roundPhase !== "drawing") {
					return socket.emit("guess_result", {
						ok: false,
						message: "not_drawing_phase",
					});
				}

				if (!room.currentWord) {
					return socket.emit("guess_result", {
						ok: false,
						message: "no_active_word",
					});
				}

				if (!socket.user || !socket.user.id) {
					return socket.emit("guess_result", {
						ok: false,
						message: "not_authenticated",
					});
				}

				// 3. Find Participant
				const participant = await RoomParticipant.findOne({
					where: { roomId: room.id, userId: socket.user.id },
				});

				if (!participant) {
					return socket.emit("guess_result", {
						ok: false,
						message: "not_in_room",
					});
				}

				// 4. Drawer cannot guess
				if (participant.isDrawer) {
					return socket.emit("guess_result", {
						ok: false,
						message: "drawer_cannot_guess",
					});
				}

				// 5. BLOCK: Only block if the player has already guessed the correct word.
				if (participant.hasGuessedThisRound) {
					return socket.emit("guess_result", {
						ok: false,
						message: "already_guessed",
					});
				}

				// 6. Team Check (Team vs Team Mode)
				if (room.gameMode === "team_vs_team") {
					const drawer = await RoomParticipant.findOne({
						where: { roomId: room.id, userId: room.currentDrawerId },
					});

					if (!drawer || participant.team !== drawer.team) {
						return socket.emit("guess_result", {
							ok: false,
							message: "wrong_team",
						});
					}
				}

				// 7. Process Guess
				const normalized = (guess || "").toString().trim().toLowerCase();
				const word = room.currentWord.toString().trim().toLowerCase();
				const isCorrect = normalized === word;

				if (isCorrect) {
					if (Date.now() > room.roundPhaseEndTime) {
						return socket.emit("guess_result", {
							ok: false,
							message: "round_ended",
						});
					}
					// --- CORRECT GUESS LOGIC ---
					const roundRemainingTime = room.roundPhaseEndTime
						? Math.max(0, Math.ceil((room.roundPhaseEndTime - Date.now()) / 1000))
						: room.roundRemainingTime;
					const reward = calculateGuessReward(
						roundRemainingTime,
						room.maxPointsPerRound,
					);

					if (room.gameMode === "team_vs_team") {
						// TEAM MODE: Award to entire team exactly once using a DB transaction/lock to avoid races.
						await sequelize.transaction(async (t) => {
							// Lock all active participants in this team for this room
							const teamParticipants = await RoomParticipant.findAll({
								where: {
									roomId: room.id,
									team: participant.team,
									isActive: true,
								},
								transaction: t,
								lock: t.LOCK.UPDATE,
							});

							// If any team member has already been marked as guessed, another request already awarded this team
							const teamHasGuessed = teamParticipants.some(
								(p) => p.hasGuessedThisRound === true,
							);
							if (teamHasGuessed) {
								return;
							}

							// First correct guess for this team: award points and mark all team members as having guessed
							for (const teamMember of teamParticipants) {
								teamMember.score += reward;
								teamMember.points_updated_at = new Date();
								teamMember.hasGuessedThisRound = true;
								await teamMember.save({ transaction: t });
							}
						});

						// After transaction commit, re-fetch latest team scores and broadcast updates
						const latestTeamParticipants = await RoomParticipant.findAll({
							where: {
								roomId: room.id,
								team: participant.team,
								isActive: true,
							},
						});
						for (const teamMember of latestTeamParticipants) {
							io.to(room.code).emit("score_update", {
								userId: teamMember.userId,
								score: teamMember.score,
							});
						}
					} else {
						// 1v1 mode: Award to individual
						const { updateParticipantScore } = require("./gameHelpers");
						await updateParticipantScore(participant, reward);

						// Send score update for individual
						io.to(room.code).emit("score_update", {
							userId: participant.userId,
							score: participant.score,
						});
					}

					// FIX: ONLY MARK as guessed IF the guess was correct.
					// In team mode we already set hasGuessedThisRound for the whole team inside the transaction above.
					if (room.gameMode !== "team_vs_team") {
						participant.hasGuessedThisRound = true;
						await participant.save();
					}
					// END FIX

					// Reduce time, broadcast, and check for round end (unchanged)
					const activePlayers = await RoomParticipant.count({
						where: { roomId: room.id, isActive: true, isDrawer: false },
					});

					// if (activePlayers > 0) {
					// 	const timeReduction = calculateTimeReduction(
					// 		room.roundRemainingTime,
					// 		activePlayers,
					// 	);
					// 	room.roundRemainingTime = Math.max(
					// 		0,
					// 		room.roundRemainingTime - timeReduction,
					// 	);
					// 	await room.save();
					// }

					io.to(room.code).emit("correct_guess", {
						by: { id: socket.user.id, name: socket.user.name },
						word: room.currentWord,
						points: reward,
						teamThatScored: participant.team || null,
						participant: {
							id: participant.userId,
							name: socket.user.name,
							score: participant.score,
							team: participant.team,
							avatar: participant.avatar,
						},
						remainingTime: roundRemainingTime,
					});
					const participants = await RoomParticipant.findAll({
						where: { roomId: room.id, isActive: true },
						include: [
							{
								model: User,
								as: "user",
								attributes: ["id", "name", "avatar", "coins"],
							},
						],
					});


					// Team vs Team - Stop drawer immediately when ANY team member guesses
					// 1v1 - Stop when all players guess
					if (room.gameMode === "team_vs_team") {
						// In team mode, end round immediately when ANY team member guesses correctly
						// (Drawer stops as soon as one team member guesses)
						const { endDrawingPhase } = require("./roundPhases");
						clearRoomTimer(`${room.code}_drawing`);
						await endDrawingPhase(io, room);
					} else {
						// 1v1 mode: End round when everyone (other than drawer) guessed, or no guessers left
						const freshRoom = await Room.findByPk(room.id);
						if (!freshRoom) return;

						const eligibleCount = await RoomParticipant.count({
							where: { roomId: freshRoom.id, isActive: true, isDrawer: false },
						});

						const guessedCount = await RoomParticipant.count({
							where: {
								roomId: freshRoom.id,
								isActive: true,
								hasGuessedThisRound: true,
							},
						});

						// End round if all guessers guessed, or there are no guessers left (someone left)
						if (eligibleCount === 0 || guessedCount >= eligibleCount) {
							const { endDrawingPhase } = require("./roundPhases");
							clearRoomTimer(`${freshRoom.code}_drawing`);
							await endDrawingPhase(io, freshRoom);
						}
					}
					io.to(room.code).emit("room_participants", {
						participants: buildParticipantList(participants, room.id),
					});
				} else {
					// --- INCORRECT GUESS LOGIC ---
					// FIX: DO NOT mark hasGuessedThisRound = true here.
					// The participant remains eligible to guess.

					// Get user info for broadcast
					const user = await User.findByPk(socket.user.id);
					const userName = user ? user.name : "Unknown";

					// Broadcast incorrect guess to all users in the room
					io.to(room.code).emit("incorrect_guess", {
						guess: guess,
						user: {
							id: socket.user.id,
							name: userName,
							team: participant.team,
							avatar: user ? user.avatar : null,
						},
					});

					// Also send result to sender
					socket.emit("guess_result", {
						ok: false,
						message: "incorrect",
						guess: guess,
						avatar: user ? user.avatar : null,
						team: participant.team,
					});
					// END FIX
				}
			} catch (e) {
				console.error("Submit guess error:", e);
			}
		});
		// Drawer skipped
		socket.on("skip_turn", async ({ roomId }) => {
			const {selectDrawerAndStartWordChoice}= require("./roundPhases")
			const MAX_SKIPS = 3;
			const room = await Room.findByPk(roomId);
			if (!room) return;

			// 1. Identify the current drawer/skipper using the current socket ID
			const skipper = await RoomParticipant.findOne({
				where: { roomId: room.id, socketId: socket.id, isDrawer: true },
				include: [{ model: User, as: "user" }],
			});

			if (!skipper) {
				// This happens if the user is not the drawer or not found
				socket.emit("error", { message: "not_your_turn_to_skip" });
				return;
			}

			// 2. CHECK SKIP COUNT AND ELIMINATE IF LIMIT EXCEEDED
			if (skipper.skipCount >= MAX_SKIPS) {
				console.log(`Player ${skipper.userId} eliminated for exceeding skip limit.`);

				// Eliminate the player
				await skipper.update({ isActive: false }); 

				// 📢 EMIT ELIMINATION SIGNAL 📢
				io.to(room.code).emit("eliminate_player", {
					message: `${skipper.user?.name || 'A player'} was eliminated for skipping too many times.`,
					eliminatedParticipant: {
						id: skipper.id,
						userId: skipper.userId,
						roomId: skipper.roomId,
						// Include necessary player data for client UI update
					}
				});

				// Reset drawer state (current drawer is now eliminated)
				room.currentDrawerId = null; 
				await room.save();

				// Attempt to start the next round/drawer selection immediately
				// Note: The selectDrawerAndStartWordChoice logic should handle the fact that the previous drawer is inactive.
				return selectDrawerAndStartWordChoice(io, room);
			}

			// 3. INCREMENT SKIP COUNT (If limit is not exceeded)
			await skipper.increment('skipCount');
			await skipper.reload(); // Reload to get the new skipCount value if needed

			// 4. PROCEED WITH TURN SKIP LOGIC

			// Clear the current drawer state for ALL participants in the room
			await RoomParticipant.update(
				{ isDrawer: false },
				{ where: { roomId: room.id } },
			);

			// Clear room state
			room.currentDrawerId = null;
			room.currentWord = null;
			room.currentWordOptions = null;

			// Check for remaining active participants
			const participants = await RoomParticipant.findAll({
				where: { roomId: room.id, isActive: true },
				include: [{ model: User, as: "user" }],
			});

			if (participants.length < 2) {
				io.to(room.code).emit("error", { message: "not_enough_players" });
				return;
			}

			await room.save();
			io.to(room.code).emit("skip_turn", { nextDrawerId: room.currentDrawerId });

			// Select the next drawer and start the new round
			selectDrawerAndStartWordChoice(io, room);
		});

		// WORD HINT (from drawer)
		socket.on(
			"word_hint",
			async ({ roomCode, roomId, revealedWord, hintsRemaining }) => {
				try {
					let room;
					if (roomCode) {
						room = await getRoomByCode(roomCode);
					} else if (roomId) {
						room = await Room.findByPk(roomId);
					}

					if (room && room.roundPhase === "drawing") {
						// Broadcast hint to all users in the room
						io.to(room.code).emit("word_hint", {
							revealedWord: revealedWord,
							hintsRemaining: hintsRemaining,
						});
						console.log(
							`💡 Word hint broadcasted to room ${room.code}: ${revealedWord}`,
						);
					}
				} catch (e) {
					console.error("Word hint error:", e);
				}
			},
		);

		// LEAVE ROOM
		socket.on("leave_room", async ({ roomCode, roomId }) => {
			try {
				let room;
				if (roomCode) {
					room = await getRoomByCode(roomCode);
				} else if (roomId) {
					room = await Room.findByPk(roomId);
				}

				if (room && socket.user) {
					const userId = socket.user.id;
					const userName = socket.user.name;

					// 1. Mark participant inactive
					await RoomParticipant.update(
						{ isActive: false, socketId: null },
						{ where: { roomId: room.id, userId: userId } },
					);
					readyState.removeReady(room.id, userId);

					socket.leave(room.code);
					clearResyncState(socket);
					console.log(`User ${socket.user.name} left room ${room.code}`);

					// Notify remaining players that this user left the room explicitly
					io.to(room.code).emit("player_left", {
						userName,
						userId,
						reason: "left_room",
					});

					// If Owner leaves, handleOwnerLeave deletes the room.
					if (room.ownerId == userId) {
						await handleOwnerLeave(io, room, socket.user.id);
						return;
					}

					// If NOT owner, handle gameplay logic (if match is ongoing)
					if (room.status === "playing") {
						await handleDrawerLeave(io, room, userId);
					}

					const roomClosed = await checkAndCloseEmptyRoom(io, room.id);

					if (!roomClosed) {
						// 3. Broadcast updated participant list
						const participants = await RoomParticipant.findAll({
							where: { roomId: room.id, isActive: true },
							include: [
								{
									model: User,
									as: "user",
									attributes: ["id", "name", "avatar", "coins"],
								},
							],
						});

						io.to(room.code).emit("room_participants", {
							participants: buildParticipantList(participants, room.id),
						});

						// If game is playing, exit when only 1 player (1v1) or <2 in any team (team mode)
						if (room.status === "playing") {
							await checkAndEndGameIfInsufficientPlayers(io, room.id);
						}
					}
				}
			} catch (e) {
				console.error("Leave room error:", e);
			} finally {
				// Ensure user is cleared from socket session
				socket.user = null; 
			}
		});

		socket.on("join_voice", async ({ roomId, userId }) => {
			// Added 'async'
			try {
				console.log(
					`🔊 Socket ${socket.id} joining voice room ${roomId} and ${userId}`,
				);
				const router = await voiceManager.join(socket.id, roomId);

				socket.data.roomId = roomId;
				socket.data.userId = userId;
				if (!router) {
					console.log(`❌ join_voice Router not found for room ${roomId}`);
					return socket.emit("error", {
						message: `Router for room ${roomId} not found`,
					});
				}

				// 1. Get router capabilities
				const routerRtpCapabilities = router.rtpCapabilities;

				// 2. Create send transport on server
				const { transport, params: sendTransportParams } =
					await voiceManager.createTransport(router);
				voiceManager.addTransport(socket.id, transport); // Store transport for later use

				// 3. Get existing producers
				const existingProducers = voiceManager.getProducers(roomId, socket.id);

				// Send initial setup data back to client
				socket.emit("voice_setup", {
					// CHANGED: Renamed from 'voice_ready' to 'voice_setup'
					routerRtpCapabilities,
					sendTransportParams,
					existingProducers, // Added existing producers
				});

				// Store room ID on socket for easier access in other handlers
				socket.room_id = roomId;

				// Notify others of a new user joining the voice channel (optional, but good practice)
				socket.to(roomId).emit("user_joined_voice", {
					userId: socket.user?.id,
					socketId: socket.id,
				});
			} catch (e) {
				console.error("Join voice error:", e);
				socket.emit("error", { message: "join_voice_failed" });
			}
		});
		// --- 1. Router RTP Capabilities ---
		socket.on("get_router_rtp_capabilities", (data) => {
			const router = voiceManager.getRouter(socket.room_id);
			if (router) {
				socket.emit("router_rtp_capabilities", router.rtpCapabilities);
			} else {
				console.log(
					`❌ get_router_rtp_capabilities Router not found for room ${socket.room_id}`,
				);
				socket.emit("error", {
					message: `Router for room ${socket.room_id} not found`,
				});
			}
		});

		// --- 2. Create Transport ---
		socket.on("create_transport", async (data) => {
			try {
				const router = voiceManager.getRouter(socket.room_id);
				if (!router) {
					console.log(
						`❌ create_transport Router not found for room ${socket.room_id}`,
					);
					return socket.emit("error", {
						message: `Router for room ${socket.room_id} not found`,
					});
				}

				const { transport, params } =
					await voiceManager.createTransport(router);
				voiceManager.addTransport(socket.id, transport);

				// Send transport params back to client
				socket.emit("transport_created", params);
			} catch (err) {
				console.error("Create transport error:", err);
				socket.emit("error", { message: err.message });
			}
		});

		// --- 3. Connect Transport ---
		socket.on("connect_transport", async (data) => {
			try {
				const { dtlsParameters, direction } = data;

				const transport = await voiceManager.connectTransport(
					socket.id,
					dtlsParameters,
				);

				if (!transport) {
					return socket.emit("error", {
						message: `Transport for socket ${socket.id} not found or failed to connect`,
					});
				}

				socket.emit("transport_connected", {
					direction: direction || "send",
					ok: true,
				});
				console.log(
					`✅ ${direction || "send"} transport connected for socket ${socket.id}`,
				);
			} catch (err) {
				console.error("Connect transport error:", err);
				socket.emit("error", { message: err.message });
			}
		});

		// --- 4. Produce (send audio) ---
		socket.on("produce", async (data) => {
			try {
				const transport = voiceManager.getTransport(socket.id);
				if (!transport) {
					return socket.emit("error", {
						message: `Transport for socket ${socket.id} not found`,
					});
				}
				if (voiceManager.getProducerBySocketId(socket.id)) {
					console.log(
						`⚠️ Producer already exists for ${socket.id}, skipping duplicate`,
					);
					return;
				}
				const producer = await transport.produce({
					kind: data.kind,
					rtpParameters: data.rtpParameters,
					appData: { userId: socket.user?.id, socketId: socket.id },
				});

				voiceManager.addProducer(socket.id, producer);

				// Notify others that a new producer appeared
				const otherSocketIds = voiceManager.getOtherSocketIds(
					socket.id,
					socket.room_id,
				);
				for (const otherSocketId of otherSocketIds) {
					io.to(otherSocketId).emit("new_producer", {
						producerId: producer.id,
						userId: socket.user?.id,
					});
				}

				socket.emit("producer_created", { id: producer.id });
			} catch (err) {
				console.error("Produce error:", err);
				socket.emit("error", { message: err.message });
			}
		});

		// --- 5. Consume (receive audio) ---

		socket.on("consume", async (data) => {
			try {
				const transport = voiceManager.getTransport(socket.id);
				if (!transport) {
					return socket.emit("error", {
						message: `Transport for socket ${socket.id} not found`,
					});
				}

				const producer = voiceManager.getProducer(data.producerId);
				if (!producer) {
					return socket.emit("error", {
						message: `Producer with id ${data.producerId} not found`,
					});
				}

				const router = voiceManager.getRouter(socket.room_id);
				if (
					!router ||
					!router.canConsume({
						producerId: producer.id,
						rtpCapabilities: data.rtpCapabilities,
					})
				) {
					return socket.emit("error", {
						message: "Cannot consume this producer",
					});
				}

				// ✅ Check if consumer already exists for this socket/producer pair
				const existingConsumer = voiceManager.getConsumerByProducerId(
					socket.id,
					data.producerId,
				);
				if (existingConsumer) {
					console.log(
						`⚠️ Consumer already exists for socket ${socket.id} and producer ${data.producerId}`,
					);
					return; // Don't create duplicate
				}

				// Create the consumer
				const consumer = await transport.consume({
					producerId: producer.id,
					rtpCapabilities: data.rtpCapabilities,
					paused: true,
				});
				voiceManager.addConsumer(socket.id, consumer);

				// Parse the client offer SDP
				const offer = data.offer ? sdpTransform.parse(data.offer) : null;

				// Build server-side SDP answer
				const sdpAnswer = voiceManager._buildConsumerAnswerSdp({
					router,
					consumer,
					offer,
				});

				// ✅ Only emit once
				socket.emit("consumer_created", {
					id: consumer.id,
					producerId: producer.id,
					kind: consumer.kind,
					rtpParameters: consumer.rtpParameters,
					sdp: sdpAnswer,
				});
				consumer.resume();
				console.log(
					`🎧 Created consumer ${consumer.id} for producer ${producer.id}`,
				);
			} catch (err) {
				console.error("❌ Consume error:", err);
				socket.emit("error", { message: err.message });
			}
		});

		socket.on("consumer_offer", async (data) => {
			try {
				const { producerId, offerSdp } = data;
				const room = voiceManager.getRoom(socket);
				if (!room) throw new Error("Room not found for this socket");
				const router = room.router;
				const sdpTransform = require("sdp-transform");

				console.log(
					`📥 consumer_offer from ${socket.id} for producer ${producerId}`,
				);

				const offer = sdpTransform.parse(offerSdp);
				const media = offer.media.find((m) => m.type === "audio");
				if (!media) throw new Error("No audio m= section found in offer");

				// Find recv transport
				const recvTransport = voiceManager.getTransport(socket.id);
				if (!recvTransport) throw new Error("Recv transport not found");

				// Find the producer
				const producer = voiceManager.getProducer(producerId);
				if (!producer) throw new Error("Producer not found");

				// Create the consumer
				const consumer = await recvTransport.consume({
					producerId: producer.id,
					rtpCapabilities: router.rtpCapabilities,
					paused: false,
				});

				voiceManager.addConsumer(socket.id, consumer);
				console.log(
					`🎧 Created consumer ${consumer.id} for producer ${producer.id}`,
				);

				// Build SDP answer using your helper
				const sdpAnswer = voiceManager._buildConsumerAnswerSdp({
					router,
					consumer,
					offer,
				});
				await consumer.resume();
				if (socket.data.lastConsumerAnswerId === consumer.id) return;
				socket.data.lastConsumerAnswerId = consumer.id;
				socket.emit("consumer_answer", {
					consumerId: consumer.id,
					sdp: sdpAnswer,
				});

				console.log(`✅ Sent consumer_answer for ${consumer.id}`);
			} catch (err) {
				console.error("❌ Error handling consumer_offer:", err);
			}
		});

		// --- 6. Resume Consumer ---
		socket.on("resume_consumer", async (data) => {
			try {
				const consumer = voiceManager.getConsumer(socket.id, data.consumerId);
				if (consumer) {
					await consumer.resume();
					socket.emit("consumer_resumed", { id: data.consumerId });
				} else {
					socket.emit("error", {
						message: `Consumer ${data.consumerId} not found`,
					});
				}
			} catch (err) {
				console.error("Resume consumer error:", err);
				socket.emit("error", { message: err.message });
			}
		});

		// --- 7. Get Producers in Room ---
		socket.on("get_producers", (data) => {
			const producers = voiceManager.getProducers(socket.room_id, socket.id);
			socket.emit("producers_list", producers);
		});

		socket.on("prepare_to_leave_permanently", () => {
			console.log("prepare_to_leave_permanently");
			socket.isPermanentLeave = true;
			
			if (socket.user && socket.roomId) {
				const key = `${socket.roomId}_${socket.user.id}`;
				// If a 90s timer is already running, override it to 1s
				if (disconnectGraceTimers.has(key)) {
					clearTimeout(disconnectGraceTimers.get(key));
					const fastTimer = setTimeout(() => {
						performParticipantCleanup(io, socket.roomId, socket.user.id, socket.roomCode);
						disconnectGraceTimers.delete(key);
					}, 1000);
					disconnectGraceTimers.set(key, fastTimer);
				}
			}
			console.log("socket.isPermanentLeave: ", socket.isPermanentLeave);
		});

		// 7. Handle standard socket disconnect (CRITICAL CLEANUP)
		// Covers: app backgrounded, app force-killed/removed from recents, network drop.
		socket.on("disconnect", async () => {
			console.log("❌ Socket disconnected:", socket.id);

			// Only remove from map if we are still the registered socket for this user.
			// Prevents rare reconnect race: new socket connects and overwrites map; old socket's
			// disconnect event fires later — we must not delete, or we'd clear the new socket's
			// registration and allow duplicate connections for that user on next connect.
			if (socket.userId && getSocketIdForUser(socket.userId) === socket.id) {
				deleteUser(socket.userId);
			}

			// Fallback if roomId wasn't set on socket
			if (!socket.roomId) {
				const p = await RoomParticipant.findOne({ where: { socketId: socket.id } });
				if (p) {
					socket.roomId = p.roomId;
					const r = await Room.findByPk(p.roomId);
					if (r) socket.roomCode = r.code;
				}
			}

			// 7b. Game Cleanup (RoomParticipant/Room status). After 90s grace, mark inactive and notify all.
			if (socket.roomId && socket.user) {
				try {
					const userId = socket.user.id;
					const roomId = socket.roomId;
					const roomCode = socket.roomCode;
					const key = `${roomId}_${userId}`;
					// Clear socketId immediately; keep isActive for grace period (rejoin from background)
					await RoomParticipant.update(
						{ socketId: null },
						{ where: { roomId, userId } },
					);

					// Broadcast updated participants (this user no longer has socketId)
					const participants = await RoomParticipant.findAll({
						where: { roomId, isActive: true },
						include: [
							{
								model: User,
								as: "user",
								attributes: ["id", "name", "avatar", "coins"],
							},
						],
					});
					io.to(roomCode).emit("room_participants", {
						participants: buildParticipantList(participants, roomId),
					});
					
					console.log("socket.isPermanentLeave: ", socket.isPermanentLeave);
					const waitTime = socket.isPermanentLeave ? 1000 : DISCONNECT_GRACE_MS;

					// After grace period, mark inactive and possibly close room (if they did not rejoin)
					// const key = `${roomId}_${userId}`;
					clearDisconnectGraceTimer(roomId, userId);
						const timer = setTimeout(async () => {
							await performParticipantCleanup(io, roomId, userId, roomCode);
							disconnectGraceTimers.delete(key);
						}, waitTime);
						disconnectGraceTimers.set(key, timer);
			} catch (e) {
				console.error("Disconnect cleanup error:", e);
				}
			}
			clearResyncState(socket);
			socket.user = undefined;
			socket.roomId = undefined;
			socket.roomCode = undefined;
			socket.isPermanentLeave = undefined;
		});
	});
};

async function performParticipantCleanup(io, roomId, userId, roomCode) {
    try {
        const p = await RoomParticipant.findOne({
            where: { roomId, userId },
            include: [{ model: User, as: "user", attributes: ["name"] }],
        });

        // Only cleanup if they haven't reconnected (socketId is still null)
        if (p && !p.socketId && p.isActive) {
            const userName = (p.user && p.user.name) ? p.user.name : "A player";
            
            await RoomParticipant.update(
                { isActive: false },
                { where: { roomId, userId } }
            );

            readyState.removeReady(roomId, userId);
            console.log(`👋 User ${userName} (${userId}) cleanup triggered (Room: ${roomCode})`);

            io.to(roomCode).emit("player_left", {
                userName,
                userId,
                reason: "left_game",
                message: `${userName} has left the game.`,
            });

            const roundPhases = require("./roundPhases");
            await roundPhases.checkAndCloseEmptyRoom(io, roomId);
            
            const stillInRoom = await RoomParticipant.findAll({
                where: { roomId, isActive: true },
                include: [{ model: User, as: "user", attributes: ["id", "name", "avatar", "coins"] }],
            });

            io.to(roomCode).emit("room_participants", {
                participants: buildParticipantList(stillInRoom, roomId),
            });

            const room = await Room.findByPk(roomId);
            const ended = await roundPhases.checkAndEndGameIfInsufficientPlayers(io, roomId);
            
            if (!ended && room) {
                if (room.ownerId === userId) {
                    await roundPhases.handleOwnerLeave(io, room, userId);
                } else if (room.status === "playing") {
                    await roundPhases.handleDrawerLeave(io, room, userId);
                }
            }
        }
    } catch (err) {
        console.error("Cleanup Execution Error:", err);
    }
}

// Check and deactivate empty room
//async function checkAndCloseEmptyRoom(io, roomId) {
//  try {
//    const activeParticipants = await RoomParticipant.count({
//      where: { roomId: roomId, isActive: true },
//    });
//
//    const room = await Room.findByPk(roomId);
//    if (!room) return false;
//    if (activeParticipants === 1 && room.status === "playing") {
//      // Set room to inactive instead of finished, so it can be reactivated
//      await Room.update({ status: "inactive" }, { where: { id: roomId } });
//
//      clearRoomTimer(room.code);
//      io.to(room.code).emit("room_closed", {
//        message: "Room is now inactive - no active participants",
//      });
//      console.log(
//        `💤 Room ${roomId} (${room.name}) set to inactive (0 participants)`,
//      );
//
//      return true;
//    }
//
//    return false;
//  } catch (error) {
//    console.error("Error checking empty room:", error);
//    return false;
//  }
//}

