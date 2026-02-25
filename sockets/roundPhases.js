const { Room, RoomParticipant, User, Word } = require("../models");
const { Op } = require("sequelize");
const { PHASE_DURATIONS, checkGameEnd } = require("./gameHelpers");
const {
	getWordsForTheme,
	getRandomWordForTheme,
} = require("../utils/wordSelector");
const { checkAndMaybeDeleteRoom } = require("../utils/cleanRoom");
const { getRoom, getRoomCached, refreshRoomCache, clearRoomCache } = require("../utils/roomCache");
const { getSocketIdForUser } = require("./userSocketMap");

// Store active timers
const roomTimers = new Map();

// Startup readiness: no joins until rebuildTimersOnStartup has completed (avoids join-before-timers edge case).
let timersReady = false;
function getTimersReady() {
	return timersReady;
}

// Stagger phase-end callbacks to avoid CPU spike when many rooms end phase at once (0–jitter ms spread).
const PHASE_END_JITTER_MS = Number(process.env.PHASE_END_JITTER_MS) || 250;

/** Base delay until phaseEndTime plus deterministic jitter from roomId. */
function phaseEndDelay(phaseEndTimeMs, roomId) {
	const base = Math.max(0, phaseEndTimeMs - Date.now());
	const jitter = roomId != null ? roomId % PHASE_END_JITTER_MS : 0;
	return base + jitter;
}

function clearRoomTimer(key) {
	if (roomTimers.has(key)) {
		const handle = roomTimers.get(key);
		clearTimeout(handle);
		clearInterval(handle); // support legacy interval handles from same map
		roomTimers.delete(key);
	}
}

/**
 * Atomic phase transition: only one caller succeeds (prevents double timers / race transitions).
 * @param {number} roomId
 * @param {string} fromPhase - Current phase; update only runs if DB matches
 * @param {object} updates - Fields to set (e.g. { roundPhase: 'reveal', roundPhaseEndTime: ... })
 * @returns {Promise<import('../models').Room|null>} Updated room or null if no row matched
 */
async function transitionPhase(roomId, fromPhase, updates) {
	const [affectedCount] = await Room.update(updates, {
		where: { id: roomId, roundPhase: fromPhase },
	});
	if (affectedCount === 0) return null;
	const room = await getRoom(roomId);
	if (room && updates.roundPhase) {
		const toPhase = updates.roundPhase;
		console.log(`[PHASE] ${fromPhase} -> ${toPhase} room=${room.code}`);
	}
	if (room) refreshRoomCache(room);
	return room;
}

/** Clear all phase-related timers for a room so no stale time_update is sent after phase change. */
function clearAllPhaseTimersForRoom(roomCode) {
	clearRoomTimer(`${roomCode}_phase`);
	clearRoomTimer(`${roomCode}_selecting_drawer`);
	clearRoomTimer(`${roomCode}_choosing_word`);
	clearRoomTimer(`${roomCode}_drawing`);
	clearRoomTimer(`${roomCode}_reveal`);
	clearRoomTimer(`${roomCode}_interval`);
}

async function removeParticipantFromRoom(io, room, userId) {
	try {
		// Mark participant inactive and clear socket id
		await RoomParticipant.update(
			{ isActive: false, socketId: null },
			{ where: { roomId: room.id, userId } }
		);

		// Optional: create a record/transaction/log for removal (omitted)
		const user = await User.findByPk(userId);

		// Broadcast to room that player was removed
		io.to(room.code).emit("player_removed", {
			userId,
			name: user ? user.name : "Guest",
			reason: "failed_to_choose_word",
		});

		console.log(`🗑️ Removed user ${userId} from room ${room.code} due to repeated misses`);

		// Check if room should be closed because of no active participants
		await checkAndCloseEmptyRoom(io, room.id);

		return true;
	} catch (err) {
		console.error("Error removing participant:", err);
		return false;
	}
}

// === NEW HELPER FUNCTION: Starts a phase with absolute-time phase-end (no timer drift) ===
// options.fromPhase: if set, do atomic transition so only one caller wins (prevents double start)
async function startPhaseTimerAndBroadcast(
	io,
	room,
	phaseKey,
	duration,
	onEndCallback,
	options = {},
) {
	const fromPhase = options.fromPhase;
	const roomId = room.id;
	const roomCode = room.code;

	if (fromPhase != null) {
		// Atomic transition: only one caller succeeds
		const phaseEndTime = new Date(Date.now() + duration * 1000);
		room = await transitionPhase(roomId, fromPhase, {
			roundPhase: phaseKey,
			roundRemainingTime: duration,
			roundPhaseEndTime: phaseEndTime,
		});
		if (!room) return;
	} else {
		clearAllPhaseTimersForRoom(roomCode);
		room.roundPhase = phaseKey;
		room.roundRemainingTime = duration;
		room.roundPhaseEndTime = new Date(Date.now() + duration * 1000);
		await room.save();
		refreshRoomCache(room);
	}
	console.log("startPhaseTimerAndBroadcast", {
		fromPhase,
		phaseKey,
		duration,
		phaseEndTime: room.roundPhaseEndTime.getTime(),
		round: room.currentRound,
	});

	// 2. Broadcast initial phase change event (client runs local countdown from phaseEndTime)
	const phaseEndTimeMs = room.roundPhaseEndTime.getTime();
	io.to(roomCode).emit("phase_change", {
		phase: phaseKey,
		duration: duration,
		phaseEndTime: phaseEndTimeMs,
		round: room.currentRound,
	});

	console.log(`⏱️ Phase started: ${phaseKey}. Duration: ${duration}s`);

	// 3. Single absolute timeout (time-authoritative; no setInterval drift)
	const phaseEndTime = room.roundPhaseEndTime.getTime
		? room.roundPhaseEndTime.getTime()
		: Number(room.roundPhaseEndTime);
	const delay = phaseEndDelay(phaseEndTime, roomId);
	const timeout = setTimeout(async () => {
		clearRoomTimer(`${roomCode}_${phaseKey}`);
		const snap = await getRoomCached(roomId);
		if (snap && snap.roundPhase === phaseKey) {
			const refreshedRoom = await getRoom(roomId);
			if (refreshedRoom) await onEndCallback(io, refreshedRoom);
		}
	}, delay);
	roomTimers.set(`${roomCode}_${phaseKey}`, timeout);
}

// Start a new round
async function startNewRound(io, room) {
	try {
		// Clear chat for new round
		io.to(room.code).emit("clear_chat");

		// Get active participants
		const participants = await RoomParticipant.findAll({
			where: { roomId: room.id, isActive: true },
			include: [{ model: User, as: "user" }],
		});

		if (participants.length < 2) {
			io.to(room.code).emit("error", { message: "not_enough_players" });
			return;
		}

		// Reset guess status
		await RoomParticipant.update(
			{ hasGuessedThisRound: false, isDrawer: false },
			{ where: { roomId: room.id } },
		);

		console.log(`🎯 Round ${room.currentRound} - Selecting drawer...`);

		// Start the selection process which now uses the ticking timer
		await selectDrawerAndStartWordChoice(io, room);
	} catch (e) {
		console.error("Start new round error:", e);
	}
}

// Select drawer and start word choice phase
async function selectDrawerAndStartWordChoice(io, room) {
	try {
		// Guard: room may be null when called after room removal/deletion (e.g. last player left)
		if (!room?.id) return;
		room = await getRoom(room.id);
		if (!room) return;

		clearRoomTimer(`${room.code}_phase`);

		// Load active participants
		let participants = await RoomParticipant.findAll({
			where: { roomId: room.id, isActive: true },
			include: [{ model: User, as: "user" }],
		});

		if (!participants.length) {
			console.log("⚠️ No participants in room:", room.code);
			return;
		}

		// Sort for stable ordering
		participants.sort((a, b) => a.userId - b.userId);

		// Ensure pointer is valid
		let pointer = room.drawerPointerIndex || 0;

		// Normalize drawnUserIds (from JSON)
		let drawnUserIds = Array.isArray(room.drawnUserIds) ? room.drawnUserIds : [];

		let nextDrawer;


		// MODE 1: 1v1 

		if (room.gameMode === "1v1") {
			pointer = pointer % participants.length;
			nextDrawer = participants[pointer];
			pointer = (pointer + 1) % participants.length;
		} else {

			// MODE 2: team_vs_team


			const blueTeam = participants
				.filter((p) => p.team === "blue")
				.sort((a, b) => a.userId - b.userId);

			const orangeTeam = participants
				.filter((p) => p.team === "orange")
				.sort((a, b) => a.userId - b.userId);

			// If teams are not properly formed, fallback to flat logic
			if (!blueTeam.length || !orangeTeam.length) {
				console.log(
					"⚠️ team_vs_team but one of the teams is empty, falling back to flat rotation",
				);
				pointer = pointer % participants.length;
				nextDrawer = participants[pointer];
				pointer = (pointer + 1) % participants.length;
			} else {
				// Create alternating list: [blue, orange, blue, orange, ...]
				const alternatingList = [];
				const maxLen = Math.max(blueTeam.length, orangeTeam.length);

				for (let i = 0; i < maxLen; i++) {
					if (i < blueTeam.length) {
						alternatingList.push(blueTeam[i]);
					}
					if (i < orangeTeam.length) {
						alternatingList.push(orangeTeam[i]);
					}
				}

				// Find next eligible drawer from alternating list
				let chosenDrawer = null;
				const totalPlayers = alternatingList.length;

				for (let i = 0; i < totalPlayers; i++) {
					const idx = (pointer + i) % totalPlayers;
					const candidate = alternatingList[idx];

					if (!drawnUserIds.includes(candidate.userId)) {
						chosenDrawer = candidate;
						pointer = (idx + 1) % totalPlayers;
						break;
					}
				}

				// If everyone has drawn, reset cycle
				if (!chosenDrawer) {
					console.log(
						"🔄 All players have drawn once. Resetting drawnUserIds cycle.",
					);
					drawnUserIds = [];
					chosenDrawer = alternatingList[pointer];
					pointer = (pointer + 1) % totalPlayers;
				}

				nextDrawer = chosenDrawer;
			}
		} 

		// Clear old drawer status
		await RoomParticipant.update(
			{ isDrawer: false },
			{ where: { roomId: room.id, isDrawer: true } },
		);

		// Mark new drawer
		await RoomParticipant.update(
			{ isDrawer: true, hasDrawn: true },
			{ where: { id: nextDrawer.id } },
		);

		// Keep track of who has drawn in this cycle
		if (!drawnUserIds.includes(nextDrawer.userId)) {
			drawnUserIds.push(nextDrawer.userId);
		}

		room.drawerPointerIndex = pointer;
		room.currentDrawerId = nextDrawer.userId;
		room.lastDrawerId = nextDrawer.userId;
		room.currentWord = null;
		room.currentWordOptions = null;
		room.drawnUserIds = drawnUserIds;
		await room.save();
		refreshRoomCache(room);

		console.log(
			`🎯 Drawer selected: ${nextDrawer.user?.name ?? "Guest"} (ID: ${
				nextDrawer.userId
			})`,
		);
		console.log(`👥 Total participants: ${participants.length}`);
		console.log(`🔁 Next pointer index: ${pointer}`);
		console.log(
			`📜 Drawn users this cycle: ${
				drawnUserIds.length ? drawnUserIds.join(", ") : "none"
			}`,
		);

		// --- Word selection logic (unchanged) ---
		let words = [];
		// if (room.themeId) {
		// Check if we have categories (array) or themeId (single theme)
		const categories = Array.isArray(room.category) && room.category.length > 0
			? room.category
			: [];

		if (categories.length > 0) {
			try {
				// Use categories array for multi-select
				words = await getWordsForTheme(
					null, // themeId is null when using categories
					room.language,
					room.script,
					3,
					room.usedWords || [],
					categories // Pass categories array
				);
			} catch (e) {
				console.log("⚠️ Error loading themed words from categories, fallback being used", e);
			}
		} else if (room.themeId) {
			// Fallback to single themeId for backward compatibility
			try {
				words = await getWordsForTheme(
					room.themeId,
					room.language,
					room.script,
					3,
					room.usedWords || []
				);
			} catch (e) {
				console.log("⚠️ Error loading themed words, fallback being used", e);
			}
		}

		if (!words || words.length < 3) {
			const fallback = [
				"apple",
				"banana",
				"cat",
				"dog",
				"elephant",
				"flower",
				"guitar",
				"house",
				"tree",
				"sun",
			];
			words = fallback.sort(() => 0.5 - Math.random()).slice(0, 3);
		}
		room.currentWordOptions = words;
		await room.save();
		refreshRoomCache(room);

		const drawerPayload = {
			id: nextDrawer.userId,
			name: nextDrawer.user?.name ?? "Guest",
			team: nextDrawer.team,
			avatar: nextDrawer.user?.avatar,
		};

		// PHASE 1: selecting_drawer
		await startPhaseTimerAndBroadcast(
			io,
			room,
			"selecting_drawer",
			PHASE_DURATIONS.selecting_drawer,
			async (io, refreshedRoom) => {
				await startWordChoicePhase(
					io,
					refreshedRoom,
					nextDrawer,
					words,
					drawerPayload,
				);
			},
		);

		io.to(room.code).emit("drawer_selected", {
			drawer: drawerPayload,
			previewDuration: PHASE_DURATIONS.selecting_drawer,
		});
	} catch (err) {
		console.error("Select drawer error:", err);
	}
}

// NEW FUNCTION: Handles the word choice phase transition
async function startWordChoicePhase(
	io,
	room,
	nextDrawer,
	words,
	drawerPayload,
) {
	room = await getRoom(room.id);
	// Allow selecting_drawer or _internal_processing (set by handleSelectingDrawerPhaseEnd atomic claim)
	if (!room || (room.roundPhase !== "selecting_drawer" && room.roundPhase !== "_internal_processing")) return;

	// Atomic transition: only one caller (timer or resume) wins selecting_drawer/_internal_processing -> choosing_word
	const phaseEndTime = new Date(Date.now() + PHASE_DURATIONS.choosing_word * 1000);
	room = await transitionPhase(room.id, room.roundPhase, {
		roundPhase: "choosing_word",
		roundPhaseEndTime: phaseEndTime,
		roundRemainingTime: PHASE_DURATIONS.choosing_word,
	});
	if (!room) return;
	room = await getRoom(room.id);

	// Find drawer's socket: use current socket from userSocketMap (FIX-1) so drawer gets word_options after reconnect.
	const drawerIdStr = String(nextDrawer.userId);
	let drawerSocket = null;
	const currentSocketId = getSocketIdForUser(nextDrawer.userId);
	if (currentSocketId) {
		drawerSocket = io.sockets.sockets.get(currentSocketId);
		// Only use if socket is in this room (reconnect may have left room briefly).
		if (drawerSocket && drawerSocket.rooms?.has(room.code)) {
			// use drawerSocket
		} else {
			drawerSocket = null;
		}
	}
	if (!drawerSocket) {
		try {
			const roomSockets = await io.in(room.code).fetchSockets();
			drawerSocket = roomSockets.find(
				(s) => s.user && String(s.user.id) === drawerIdStr,
			);
		} catch (e) {
			console.warn("fetchSockets failed, falling back to global lookup:", e?.message);
		}
	}
	if (!drawerSocket) {
		drawerSocket = Array.from(io.sockets.sockets.values()).find(
			(s) => s.user && String(s.user.id) === drawerIdStr,
		);
	}

	// Re-resolve drawer socket immediately before emit so we use current socket if drawer reconnected in the meantime ("arrive while sending").
	const latestSocketId = getSocketIdForUser(nextDrawer.userId);
	if (latestSocketId && latestSocketId !== drawerSocket?.id) {
		const latestSocket = io.sockets.sockets.get(latestSocketId);
		if (latestSocket && latestSocket.rooms?.has(room.code)) drawerSocket = latestSocket;
	}

	// Send word list to drawer only
	if (drawerSocket) {
		drawerSocket.emit("word_options", {
			words,
			duration: PHASE_DURATIONS.choosing_word,
		});
		console.log(`📝 word_options sent to drawer ${nextDrawer.user?.name ?? nextDrawer.userId} (${words?.length ?? 0} words)`);
	} else {
		console.warn(`⚠️ Drawer socket not found for userId ${nextDrawer.userId} (room ${room.code}). word_options not sent.`);
	}

	// ----------------------------------------------------
	// PHASE 2: choosing_word - Now uses ticker
	// ----------------------------------------------------
	await startPhaseTimerAndBroadcast(
		io,
		room,
		"choosing_word",
		PHASE_DURATIONS.choosing_word,
		async (io, currentRoom) => {
			try {
				// Timer ended, drawer timed out
				console.log(`⏰ Drawer ${drawerPayload.name} timed out. Processing skip.`);

				// Fetch participant fresh
				const participant = await RoomParticipant.findOne({
					where: { roomId: currentRoom.id, userId: nextDrawer.userId },
				});

				if (!participant) {
					console.warn("⚠️ Participant not found when handling timeout:", nextDrawer.userId);
					// Continue rotation anyway
					await selectDrawerAndStartWordChoice(io, currentRoom);
					return;
				}

				// Decrement eliminationCount (but not below 0)
				const newEliminationCount = Math.max(0, (participant.eliminationCount || 0) - 1);
				await RoomParticipant.update(
					{ eliminationCount: newEliminationCount, isDrawer: false },
					{ where: { id: participant.id } }
				);

				// Refresh room state
				const refreshedRoom = await getRoom(currentRoom.id);

				// Inform room a drawer was skipped
				io.to(refreshedRoom.code).emit("drawer_skipped", {
					drawer: drawerPayload,
					remainingEliminations: newEliminationCount,
				});

				// If eliminationCount reached zero -> remove participant
				if (newEliminationCount <= 0) {
					console.log(`❌ Drawer ${drawerPayload.name} reached elimination 0. Removing from room.`);

					const removed = await removeParticipantFromRoom(io, refreshedRoom, participant.userId);

					if (!removed) {
						console.warn("⚠️ Failed to remove participant cleanly:", participant.userId);
					}

					// Continue rotation with refreshed room (participant list will not include removed)
					const afterRemovalRoom = await getRoom(refreshedRoom.id);
					await selectDrawerAndStartWordChoice(io, afterRemovalRoom);
					return;
				}

				// Atomic: only one caller (timeout vs resume) wins choosing_word -> selecting_drawer
				const room = await transitionPhase(refreshedRoom.id, "choosing_word", {
					roundPhase: "selecting_drawer",
					currentDrawerId: null,
					currentWord: null,
					currentWordOptions: null,
				});
				if (!room) return;
				await selectDrawerAndStartWordChoice(io, room);
			} catch (err) {
				console.error("Error handling choosing_word timeout:", err);
				try {
					// Try to continue rotation even on error
					const fallbackRoom = await getRoom(room.id);
					if (fallbackRoom) await selectDrawerAndStartWordChoice(io, fallbackRoom);
				} catch (e) {
					console.error("Fallback rotation error:", e);
				}
			}
		},
	);
}


// Start drawing phase
async function startDrawingPhase(io, room) {
	try {
		room = await getRoom(room.id);
		if (!room || room.roundPhase !== "choosing_word") return;

		// Atomic transition: only one caller wins (choose_word handler; no timer races this path)
		const phaseEndTime = new Date(Date.now() + PHASE_DURATIONS.drawing * 1000);
		room = await transitionPhase(room.id, "choosing_word", {
			roundPhase: "drawing",
			roundPhaseEndTime: phaseEndTime,
			roundRemainingTime: PHASE_DURATIONS.drawing,
			roundStartTime: new Date(),
		});
		if (!room) return;
		room = await getRoom(room.id);

		clearAllPhaseTimersForRoom(room.code);

		// room already in "drawing" from atomic transition; update usedWords if needed
		let currentUsed = room.usedWords || [];

		// Add the current word if it's not already there
		if (room.currentWord && !currentUsed.includes(room.currentWord)) {
			currentUsed.push(room.currentWord);

			// Update the room object
			room.usedWords = currentUsed;

			// If you are using Sequelize with JSON columns, we might need this:
			if (room.changed) room.changed('usedWords', true);

			console.log(`Added "${room.currentWord}" to used words list. Total used: ${currentUsed.length}`);
		}

		room.roundRemainingTime = PHASE_DURATIONS.drawing;
		room.roundStartTime = new Date();
		room.roundPhaseEndTime = new Date(
			Date.now() + PHASE_DURATIONS.drawing * 1000,
		);
		await room.save();
		refreshRoomCache(room);

		const wordHint = room.currentWord
			.split("")
			.map(() => "_")
			.join(" ");

		const phaseEndTimeMs = room.roundPhaseEndTime.getTime();
		io.to(room.code).emit("phase_change", {
			phase: "drawing",
			duration: PHASE_DURATIONS.drawing,
			phaseEndTime: phaseEndTimeMs,
			wordHint,
			word: room.currentWord, // Only drawer will use this
		});

		console.log(`🎨 Drawing phase started - Word: ${room.currentWord}`);
		// Single absolute timeout (time-authoritative; no setInterval drift)
		const roomId = room.id;
		const roomCode = room.code;
		const delay = phaseEndDelay(phaseEndTimeMs, roomId);
		const timeout = setTimeout(async () => {
			clearRoomTimer(`${roomCode}_drawing`);
			const snap = await getRoomCached(roomId);
			if (snap && snap.roundPhase === "drawing") {
				const refreshedRoom = await getRoom(roomId);
				if (refreshedRoom) await endDrawingPhase(io, refreshedRoom);
			}
		}, delay);
		roomTimers.set(`${roomCode}_drawing`, timeout);
	} catch (e) {
		console.error("Start drawing phase error:", e);
	}
}

// End drawing phase and start reveal
async function endDrawingPhase(io, room) {
	try {
		console.log("End drawing phase");
		clearRoomTimer(`${room.code}_drawing`);

		// Atomic transition: only one caller (timer or all-guessed) wins
		const revealEndTime = new Date(Date.now() + PHASE_DURATIONS.reveal * 1000);
		room = await transitionPhase(room.id, "drawing", {
			roundPhase: "reveal",
			roundPhaseEndTime: revealEndTime,
			roundRemainingTime: PHASE_DURATIONS.reveal,
		});
		if (!room) return;

		// Award points to drawer based on how many guessed
		const guessedCount = await RoomParticipant.count({
			where: { roomId: room.id, hasGuessedThisRound: true },
		});

		const drawer = await RoomParticipant.findOne({
			where: { roomId: room.id, userId: room.currentDrawerId },
			include: [{ model: User, as: "user" }],
		});

		// Get participants early (needed for drawer points formula and for phase_change payload)
		const participants = await RoomParticipant.findAll({
			where: { roomId: room.id, isActive: true },
			include: [{ model: User, as: "user" }],
		});

		const eligibleGuessers = Math.max(1, participants.length - 1);
		// Drawer points only in 1v1; team vs team has no drawer points (whole team gets guess points only)
		if (drawer && guessedCount > 0 && room.gameMode !== "team_vs_team") {
			const drawerPoints = Math.min(((20*guessedCount)/eligibleGuessers), room.maxPointsPerRound);
			const { updateParticipantScore } = require("./gameHelpers");
			await updateParticipantScore(drawer, drawerPoints);
			io.to(room.code).emit("score_update", {
				userId: drawer.userId,
				score: drawer.score,
			});
			console.log(
				` Drawer ${drawer.user?.name} earned ${drawerPoints} points (${guessedCount} guessed)`,
			);
		}

		const drawerRewardValue =
			room.gameMode === "team_vs_team"
				? 0
				: drawer && guessedCount > 0
					? Math.min(((20*guessedCount)/eligibleGuessers), room.maxPointsPerRound)
					: 0;

		const phaseEndTimeMs = room.roundPhaseEndTime.getTime();
		io.to(room.code).emit("phase_change", {
			phase: "reveal",
			duration: PHASE_DURATIONS.reveal,
			phaseEndTime: phaseEndTimeMs,
			word: room.currentWord,
			drawerReward: drawerRewardValue,
			participants: participants.map((p) => ({
				id: p.userId,
				name: p.user?.name || "Guest",
				score: p.score,
				team: p.team,
			})),
		});

		console.log(`📢 Reveal phase - Word was: ${room.currentWord}`);

		// Check if game should end
		const gameEnded = await checkGameEnd(io, room);
		if (gameEnded) {
			return;
		}

		// Single absolute timeout (time-authoritative; no setInterval drift)
		const roomCode = room.code;
		const roomId = room.id;
		const revealPhaseEndTimeMs = room.roundPhaseEndTime.getTime
			? room.roundPhaseEndTime.getTime()
			: Number(room.roundPhaseEndTime);
		const delay = phaseEndDelay(revealPhaseEndTimeMs, roomId);
		const timeout = setTimeout(async () => {
			clearRoomTimer(`${roomCode}_reveal`);
			clearRoomTimer(`${roomCode}_phase`);
			const snap = await getRoomCached(roomId);
			if (snap && snap.roundPhase === "reveal") {
				const refreshedRoom = await getRoom(roomId);
				if (refreshedRoom) await startIntervalPhase(io, refreshedRoom);
			}
		}, delay);
		roomTimers.set(`${roomCode}_reveal`, timeout);
		roomTimers.set(`${roomCode}_phase`, timeout);
	} catch (e) {
		console.error("End drawing phase error:", e);
	}
}

// Start interval phase (atomic transition from reveal so only one caller wins)
async function startIntervalPhase(io, room) {
	console.log("Start interval phase");
	try {
		clearRoomTimer(`${room.code}_reveal`);
		// Atomic: only one caller (timer or resume) transitions reveal -> interval
		await startPhaseTimerAndBroadcast(
			io,
			room,
			"interval",
			PHASE_DURATIONS.interval,
			async (io, refreshedRoom) => {
				// Atomic: only one caller (timer or resume) transitions interval -> next round
				const claimed = await transitionPhase(refreshedRoom.id, "interval", {
					roundPhase: "interval_ending",
				});
				if (!claimed) return;
				claimed.currentRound += 1;
				await claimed.save();
				refreshRoomCache(claimed);
				await startNewRound(io, claimed);
			},
			{ fromPhase: "reveal" },
		);
		// If we lost the race (another caller already transitioned), startPhaseTimerAndBroadcast returned early
		room = await getRoom(room.id);
		if (!room || room.roundPhase !== "interval") return;
		console.log(`⏸️ Interval phase`);
	} catch (e) {
		console.error("Start interval phase error:", e);
	}
}

async function handleDrawerLeave(io, room, userId) {
	try {
		if (room.currentDrawerId !== userId || room.roundPhase !== "drawing") {
			return false; // Not the current drawer or not in drawing phase
		}

		console.log(
			`🚨 Current drawer (${userId}) left the room ${room.code}. Initiating phase change.`,
		);

		// 1. Clear any active round timers (drawing/hint/etc.)
		clearRoomTimer(`${room.code}_drawing`);

		// 2. Clear current drawing state in the Room model
		room.currentDrawerId = null;
		room.currentWord = null;
		room.currentWordOptions = null;

		// Set interval end time
		room.roundPhaseEndTime = new Date(
			Date.now() + PHASE_DURATIONS.interval * 1000,
		);

		await room.save();
		refreshRoomCache(room);

		// 3. Start the interval phase using the ticking timer
		await startPhaseTimerAndBroadcast(
			io,
			room,
			"interval",
			PHASE_DURATIONS.interval,
			async (io, refreshedRoom) => {
				// Timer ended, transition to new round
				await startNewRound(io, refreshedRoom);
			},
		);
		await checkAndMaybeDeleteRoom(io, room.id);

		return true; // Drawer leave successfully handled
	} catch (error) {
		console.error("Error handling drawer leave:", error);
		return false;
	}
}

/**
 * Called when choosing_word phase timer ends (timeout or resume). Refetches room and drawer,
 * then runs the same drawer-skip/elimination logic as the normal phase end.
 */
async function handleChoosingWordTimeout(io, room) {
	try {
		// Optimistic concurrency: only one concurrent caller can update the row
		const updateResult = await Room.update(
			{ roundPhase: "_internal_processing" },
			{ where: { id: room.id, roundPhase: "choosing_word" } }
		);
		const affected = Array.isArray(updateResult) ? updateResult[0] : updateResult;
		if (affected === 0) return;

		const refreshedRoom = await getRoom(room.id);
		if (!refreshedRoom || !refreshedRoom.currentDrawerId) {
			return;
		}
		const participant = await RoomParticipant.findOne({
			where: { roomId: refreshedRoom.id, userId: refreshedRoom.currentDrawerId },
			include: [{ model: User, as: "user", attributes: ["id", "name", "avatar"] }],
		});
		if (!participant) {
			await selectDrawerAndStartWordChoice(io, refreshedRoom);
			return;
		}
		const drawerPayload = {
			id: participant.userId,
			name: participant.user?.name ?? "Guest",
			team: participant.team,
			avatar: participant.user?.avatar,
		};
		console.log(`⏰ Drawer ${drawerPayload.name} timed out. Processing skip.`);
		const newEliminationCount = Math.max(0, (participant.eliminationCount || 0) - 1);
		await RoomParticipant.update(
			{ eliminationCount: newEliminationCount, isDrawer: false },
			{ where: { id: participant.id } }
		);
		const r = await getRoom(refreshedRoom.id);
		io.to(r.code).emit("drawer_skipped", {
			drawer: drawerPayload,
			remainingEliminations: newEliminationCount,
		});
		if (newEliminationCount <= 0) {
			const removed = await removeParticipantFromRoom(io, r, participant.userId);
			const afterRemovalRoom = await getRoom(r.id);
			await selectDrawerAndStartWordChoice(io, afterRemovalRoom);
			return;
		}
		// Atomic: only one caller (timeout vs resume) wins choosing_word -> selecting_drawer
		const nextRoom = await transitionPhase(r.id, "choosing_word", {
			roundPhase: "selecting_drawer",
			currentDrawerId: null,
			currentWord: null,
			currentWordOptions: null,
		});
		if (!nextRoom) return;
		await selectDrawerAndStartWordChoice(io, nextRoom);
	} catch (err) {
		console.error("Error handling choosing_word timeout:", err);
		try {
			const fallbackRoom = await getRoom(room.id);
			if (fallbackRoom) await selectDrawerAndStartWordChoice(io, fallbackRoom);
		} catch (e) {
			console.error("Fallback rotation error:", e);
		}
	}
}

/**
 * Called when selecting_drawer phase timer ends (timeout or resume). Refetches room and drawer,
 * gets words from room.currentWordOptions (or fetches), then starts the word choice phase.
 */
async function handleSelectingDrawerPhaseEnd(io, room) {
	try {
		// Optimistic concurrency: only one concurrent caller can update the row
		const updateResult = await Room.update(
			{ roundPhase: "_internal_processing" },
			{ where: { id: room.id, roundPhase: "selecting_drawer" } }
		);
		const affected = Array.isArray(updateResult) ? updateResult[0] : updateResult;
		if (affected === 0) return;

		const refreshedRoom = await getRoom(room.id);
		if (!refreshedRoom || !refreshedRoom.currentDrawerId) {
			return;
		}
		const participant = await RoomParticipant.findOne({
			where: { roomId: refreshedRoom.id, userId: refreshedRoom.currentDrawerId },
			include: [{ model: User, as: "user", attributes: ["id", "name", "avatar"] }],
		});
		if (!participant) {
			await selectDrawerAndStartWordChoice(io, refreshedRoom);
			return;
		}
		const nextDrawer = { id: participant.id, userId: participant.userId, user: participant.user, team: participant.team };
		const drawerPayload = {
			id: participant.userId,
			name: participant.user?.name ?? "Guest",
			team: participant.team,
			avatar: participant.user?.avatar,
		};
		let words = refreshedRoom.currentWordOptions && refreshedRoom.currentWordOptions.length >= 3
			? refreshedRoom.currentWordOptions
			: [];
		if (words.length < 3) {
			const categories = Array.isArray(refreshedRoom.category) && refreshedRoom.category.length > 0 ? refreshedRoom.category : [];
			if (categories.length > 0) {
				try {
					words = await getWordsForTheme(null, refreshedRoom.language, refreshedRoom.script, 3, refreshedRoom.usedWords || [], categories);
				} catch (e) {
					console.warn("Resume selecting_drawer: getWordsForTheme failed", e?.message);
				}
			} else if (refreshedRoom.themeId) {
				try {
					words = await getWordsForTheme(refreshedRoom.themeId, refreshedRoom.language, refreshedRoom.script, 3, refreshedRoom.usedWords || []);
				} catch (e) {
					console.warn("Resume selecting_drawer: getWordsForTheme failed", e?.message);
				}
			}
			if (!words || words.length < 3) {
				words = ["apple", "banana", "cat", "dog", "elephant", "flower", "guitar", "house", "tree", "sun"]
					.sort(() => 0.5 - Math.random()).slice(0, 3);
			}
		}
		await startWordChoicePhase(io, refreshedRoom, nextDrawer, words, drawerPayload);
	} catch (err) {
		console.error("Error handling selecting_drawer phase end:", err);
		try {
			const fallbackRoom = await getRoom(room.id);
			if (fallbackRoom) await selectDrawerAndStartWordChoice(io, fallbackRoom);
		} catch (e) {
			console.error("Fallback selectDrawerAndStartWordChoice error:", e);
		}
	}
}

/**
 * After a server restart or when a user rejoins from background, phase timers may be cleared.
 * Call this to restart the phase timer so time_update events are sent and the round can progress.
 * Handles selecting_drawer, choosing_word, drawing, reveal, and interval.
 */
async function resumePhaseTimerIfNeeded(io, room) {
	try {
		clearAllPhaseTimersForRoom(room.code);
		const refreshedRoom = await getRoom(room.id);
		if (!refreshedRoom || refreshedRoom.status !== "playing" || !refreshedRoom.roundPhase) {
			return;
		}
		// Derive remaining from roundPhaseEndTime (no longer updated per second in DB)
		const phaseEndTime =
			refreshedRoom.roundPhaseEndTime ||
			new Date(Date.now() + (refreshedRoom.roundRemainingTime ?? 0) * 1000);
		let remaining = Math.max(
			0,
			Math.ceil((phaseEndTime - Date.now()) / 1000),
		);

		// selecting_drawer: resume with absolute timeout
		if (refreshedRoom.roundPhase === "selecting_drawer") {
			if (remaining <= 0) {
				await handleSelectingDrawerPhaseEnd(io, refreshedRoom);
				return;
			}
			const phaseEndTimeMs = phaseEndTime.getTime ? phaseEndTime.getTime() : Number(phaseEndTime);
			const fullDuration = PHASE_DURATIONS.selecting_drawer;
			io.to(refreshedRoom.code).emit("phase_change", {
				phase: "selecting_drawer",
				duration: fullDuration,
				phaseEndTime: phaseEndTimeMs,
				round: refreshedRoom.currentRound,
			});
			clearRoomTimer(`${refreshedRoom.code}_selecting_drawer`);
			const roomCode = refreshedRoom.code;
			const roomId = refreshedRoom.id;
			const delay = phaseEndDelay(phaseEndTimeMs, roomId);
			const timeout = setTimeout(async () => {
				clearRoomTimer(`${roomCode}_selecting_drawer`);
				const snap = await getRoomCached(roomId);
				if (snap && snap.roundPhase === "selecting_drawer") {
					const r = await getRoom(roomId);
					if (r) await handleSelectingDrawerPhaseEnd(io, r);
				}
			}, delay);
			roomTimers.set(`${roomCode}_selecting_drawer`, timeout);
			console.log(`⏱️ Resumed selecting_drawer phase timer for room ${roomCode} (${remaining}s remaining)`);
			return;
		}

		// choosing_word: resume with absolute timeout
		if (refreshedRoom.roundPhase === "choosing_word") {
			if (remaining <= 0) {
				await handleChoosingWordTimeout(io, refreshedRoom);
				return;
			}
			const phaseEndTimeMs = phaseEndTime.getTime ? phaseEndTime.getTime() : Number(phaseEndTime);
			const fullDuration = PHASE_DURATIONS.choosing_word;
			io.to(refreshedRoom.code).emit("phase_change", {
				phase: "choosing_word",
				duration: fullDuration,
				phaseEndTime: phaseEndTimeMs,
				round: refreshedRoom.currentRound,
			});
			clearRoomTimer(`${refreshedRoom.code}_choosing_word`);
			const roomCode = refreshedRoom.code;
			const roomId = refreshedRoom.id;
			const delay = phaseEndDelay(phaseEndTimeMs, roomId);
			const timeout = setTimeout(async () => {
				clearRoomTimer(`${roomCode}_choosing_word`);
				const snap = await getRoomCached(roomId);
				if (snap && snap.roundPhase === "choosing_word") {
					const r = await getRoom(roomId);
					if (r) await handleChoosingWordTimeout(io, r);
				}
			}, delay);
			roomTimers.set(`${roomCode}_choosing_word`, timeout);
			console.log(`⏱️ Resumed choosing_word phase timer for room ${roomCode} (${remaining}s remaining)`);
			return;
		}

		if (refreshedRoom.roundPhase === "drawing") {
			if (remaining <= 0) {
				await endDrawingPhase(io, refreshedRoom);
				return;
			}
			const phaseEndTimeMs = phaseEndTime.getTime ? phaseEndTime.getTime() : Number(phaseEndTime);
			const fullDuration = PHASE_DURATIONS.drawing;
			io.to(refreshedRoom.code).emit("phase_change", {
				phase: "drawing",
				duration: fullDuration,
				phaseEndTime: phaseEndTimeMs,
			});
			clearRoomTimer(`${refreshedRoom.code}_drawing`);
			const roomCode = refreshedRoom.code;
			const roomId = refreshedRoom.id;
			const delay = phaseEndDelay(phaseEndTimeMs, roomId);
			const timeout = setTimeout(async () => {
				clearRoomTimer(`${roomCode}_drawing`);
				const snap = await getRoomCached(roomId);
				if (snap && snap.roundPhase === "drawing") {
					const r = await getRoom(roomId);
					if (r) await endDrawingPhase(io, r);
				}
			}, delay);
			roomTimers.set(`${roomCode}_drawing`, timeout);
			console.log(`⏱️ Resumed drawing phase timer for room ${roomCode} (${remaining}s remaining)`);
			return;
		}

		if (refreshedRoom.roundPhase === "reveal") {
			if (remaining <= 0) {
				await startIntervalPhase(io, refreshedRoom);
				return;
			}
			const phaseEndTimeMs = phaseEndTime.getTime ? phaseEndTime.getTime() : Number(phaseEndTime);
			const fullDuration = PHASE_DURATIONS.reveal;
			io.to(refreshedRoom.code).emit("phase_change", {
				phase: "reveal",
				duration: fullDuration,
				phaseEndTime: phaseEndTimeMs,
			});
			clearRoomTimer(`${refreshedRoom.code}_reveal`);
			const roomCode = refreshedRoom.code;
			const roomId = refreshedRoom.id;
			const delay = phaseEndDelay(phaseEndTimeMs, roomId);
			const timeout = setTimeout(async () => {
				clearRoomTimer(`${roomCode}_reveal`);
				const snap = await getRoomCached(roomId);
				if (snap && snap.roundPhase === "reveal") {
					const r = await getRoom(roomId);
					if (r) await startIntervalPhase(io, r);
				}
			}, delay);
			roomTimers.set(`${roomCode}_reveal`, timeout);
			console.log(`⏱️ Resumed reveal phase timer for room ${roomCode} (${remaining}s remaining)`);
			return;
		}

		if (refreshedRoom.roundPhase === "interval") {
			const intervalPhaseEndTime =
				refreshedRoom.roundPhaseEndTime ||
				new Date(Date.now() + (refreshedRoom.roundRemainingTime ?? 0) * 1000);
			const intervalPhaseEndTimeMs = intervalPhaseEndTime.getTime
				? intervalPhaseEndTime.getTime()
				: Number(intervalPhaseEndTime);
			remaining = Math.max(0, Math.ceil((intervalPhaseEndTimeMs - Date.now()) / 1000));
			if (remaining <= 0) {
				return;
			}
			clearRoomTimer(`${refreshedRoom.code}_phase`);
			clearRoomTimer(`${refreshedRoom.code}_interval`);
			const phaseEndTimeMs = intervalPhaseEndTimeMs;
			const fullDuration = PHASE_DURATIONS.interval;
			io.to(refreshedRoom.code).emit("phase_change", {
				phase: "interval",
				duration: fullDuration,
				phaseEndTime: phaseEndTimeMs,
			});
			const roomCode = refreshedRoom.code;
			const roomId = refreshedRoom.id;
			const delay = phaseEndDelay(phaseEndTimeMs, roomId);
			const timeout = setTimeout(async () => {
				clearRoomTimer(`${roomCode}_interval`);
				const snap = await getRoomCached(roomId);
				if (!snap || snap.roundPhase !== "interval") return;
				const r = await getRoom(roomId);
				if (!r) return;
				const claimed = await transitionPhase(roomId, "interval", { roundPhase: "interval_ending" });
				if (!claimed) return;
				claimed.currentRound += 1;
				await claimed.save();
				refreshRoomCache(claimed);
				await startNewRound(io, claimed);
			}, delay);
			roomTimers.set(`${roomCode}_interval`, timeout);
			console.log(`⏱️ Resumed interval phase timer for room ${refreshedRoom.code} (${remaining}s remaining)`);
		}
	} catch (e) {
		console.error("Resume phase timer error:", e);
	}
}

async function handleOwnerLeave(io, room, userId) {
	if (room.ownerId !== userId) return false;
	console.log(`Owner Left the room`);
	const { deleteRoom } = require("../utils/cleanRoom");

	console.log(`🚨 Owner (${userId}) left room ${room.code}. Deleting room.`);
	await deleteRoom(io, room);
	return true;
}



// Check and deactivate empty room (only when zero active participants)
async function checkAndCloseEmptyRoom(io, roomId) {
	try {
		const activeParticipants = await RoomParticipant.count({
			where: { roomId: roomId, isActive: true },
		});

		const room = await getRoom(roomId);
		if (!room) return true;

		if (activeParticipants === 0) {
			const { deleteRoom } = require("../utils/cleanRoom");
			await deleteRoom(io, room);
			console.log(`💤 Room ${roomId} (${room.name}) deleted (0 participants).`);
			return true;
		}
		// When 1 active participant remains, do not close — they may be the last one, or others are in grace period (app background)

		return false;
	} catch (error) {
		console.error("Error checking empty room:", error);
		return false;
	}
}

/**
 * On server start: mark all participants with socketId=null and isActive=true as inactive,
 * then run checkAndCloseEmptyRoom for each affected room. Fixes crash/restart case where
 * in-memory grace timers were lost and rooms stayed "active" forever.
 * @param {object} io - Socket.io server
 * @returns {Promise<void>}
 */
async function sweepStaleParticipantsOnStart(io) {
	try {
		const stale = await RoomParticipant.findAll({
			where: { socketId: null, isActive: true },
			attributes: ["roomId"],
		});
		if (stale.length === 0) return;

		const roomIds = [...new Set(stale.map((p) => p.roomId))];
		await RoomParticipant.update(
			{ isActive: false },
			{ where: { socketId: null, isActive: true } }
		);
		for (const roomId of roomIds) {
			await checkAndCloseEmptyRoom(io, roomId);
		}
		console.log(
			`🧹 Startup sweep: marked ${stale.length} stale participant(s) inactive, checked ${roomIds.length} room(s).`
		);
	} catch (error) {
		console.error("Error sweepStaleParticipantsOnStart:", error);
	}
}

/**
 * If game is playing and there are insufficient active players (1v1: < 2; team_vs_team: < 2 in any team),
 * end the game: clear timers, set room status to closed, emit game_ended_insufficient_players so clients exit.
 * Uses only isActive participants (after 90s grace, left users are already inactive).
 * @param {object} io - Socket.io server
 * @param {number} roomId - Room id
 * @returns {Promise<boolean>} - true if game was ended due to insufficient players
 */
async function checkAndEndGameIfInsufficientPlayers(io, roomId) {
	try {
		const room = await getRoom(roomId);
		if (!room || room.status !== "playing") return false;

		const participants = await RoomParticipant.findAll({
			where: { roomId, isActive: true },
		});

		let shouldEnd = false;
		let message = "Not enough players. Room closed.";

		if (room.gameMode === "team_vs_team") {
			const blueCount = participants.filter((p) => p.team === "blue").length;
			const orangeCount = participants.filter((p) => p.team === "orange").length;
			if (blueCount < 2 || orangeCount < 2) {
				shouldEnd = true;
				message =
					blueCount < 2 && orangeCount < 2
						? "Both teams need at least 2 players. Room closed."
						: "Each team needs at least 2 players. Room closed.";
			}
		} else {
			// 1v1 or individual: need at least 2 players
			if (participants.length < 2) {
				shouldEnd = true;
				message = "Not enough players to continue. Room closed.";
			}
		}

		if (!shouldEnd) return false;

		clearRoomTimer(`${room.code}_phase`);
		clearRoomTimer(`${room.code}_drawing`);
		await Room.update({ status: "closed" }, { where: { id: roomId } });
		io.to(room.code).emit("game_ended_insufficient_players", { message });
		console.log(
			`🛑 Game ended in room ${room.code} - insufficient players (${room.gameMode})`
		);
		return true;
	} catch (error) {
		console.error("Error checkAndEndGameIfInsufficientPlayers:", error);
		return false;
	}
}

/**
 * Abort the current drawer's turn (e.g. due to report). Clears drawer state and selects next drawer.
 * @param {object} io - Socket.io server
 * @param {object} room - Room model instance
 * @param {number} userId - User id of the drawer to abort
 * @returns {Promise<boolean>} - true if drawer was aborted, false if user was not the current drawer
 */
async function abortDrawerForUser(io, room, userId) {
	const uid = Number(userId);
	if (!Number.isFinite(uid)) return false;

	clearRoomTimer(`${room.code}_phase`);
	const refreshedRoom = await getRoom(room.id);
	if (!refreshedRoom) return false;
	const currentDrawerId = refreshedRoom.currentDrawerId != null ? Number(refreshedRoom.currentDrawerId) : null;
	if (currentDrawerId !== uid) {
		return false;
	}
	const phase = refreshedRoom.roundPhase;
	if (phase !== "drawing" && phase !== "choosing_word") {
		return false;
	}
	const participant = await RoomParticipant.findOne({
		where: { roomId: refreshedRoom.id, userId: uid },
		include: [{ model: User, as: "user" }],
	});
	if (!participant) return false;

	await RoomParticipant.update(
		{ isDrawer: false },
		{ where: { id: participant.id } }
	);
	// Atomic: only one caller wins (report vs timer) drawing/choosing_word -> selecting_drawer
	const updatedRoom = await transitionPhase(refreshedRoom.id, refreshedRoom.roundPhase, {
		roundPhase: "selecting_drawer",
		currentDrawerId: null,
		currentWord: null,
		currentWordOptions: null,
	});
	if (!updatedRoom) return false;

	const drawerPayload = {
		id: participant.userId,
		name: participant.user?.name ?? "Guest",
		team: participant.team,
		avatar: participant.user?.avatar,
	};
	io.to(updatedRoom.code).emit("drawer_skipped", {
		drawer: drawerPayload,
		reason: "report",
	});
	await selectDrawerAndStartWordChoice(io, updatedRoom);
	return true;
}

/**
 * After server restart, timers are lost. Rebuild them from roundPhaseEndTime for all rooms in a timed phase.
 * Call once after DB is ready and io is attached (e.g. in initializeServices).
 */
async function rebuildTimersOnStartup(io) {
	try {
		const rooms = await Room.findAll({
			where: {
				status: "playing",
				roundPhase: {
					[Op.in]: ["selecting_drawer", "choosing_word", "drawing", "reveal", "interval"],
				},
			},
		});
		for (const room of rooms) {
			await resumePhaseTimerIfNeeded(io, room);
		}
		if (rooms.length > 0) {
			console.log(`⏱️ Rebuilt phase timers for ${rooms.length} room(s) after startup`);
		}
	} catch (e) {
		console.error("rebuildTimersOnStartup error:", e);
	} finally {
		timersReady = true; // Allow joins even if rebuild had errors (avoid blocking forever)
	}
}

module.exports = {
	startNewRound,
	selectDrawerAndStartWordChoice,
	startDrawingPhase,
	endDrawingPhase,
	startIntervalPhase,
	clearRoomTimer,
	clearAllPhaseTimersForRoom,
	roomTimers,
	handleDrawerLeave,
	handleOwnerLeave,
	checkAndCloseEmptyRoom,
	sweepStaleParticipantsOnStart,
	checkAndEndGameIfInsufficientPlayers,
	startWordChoicePhase, // Exporting new helper function for external use if needed
	startPhaseTimerAndBroadcast, // Exporting new helper function
	resumePhaseTimerIfNeeded,
	abortDrawerForUser,
	rebuildTimersOnStartup,
	getTimersReady,
	transitionPhase,
};

