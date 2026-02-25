const express = require("express");
const router = express.Router();
const { Report, Room, RoomParticipant, User, sequelize } = require("../models");
const { abortDrawerForUser } = require("../sockets/roundPhases");
const { deleteRoom } = require("../utils/cleanRoom");

/**
 * After removing a participant, decide if the room should be closed.
 * - 1v1: close if <= 1 member left (can't play alone).
 * - team_vs_team: close if any team has < 2 active members (need at least 2 per team).
 * @param {object} room - Room model instance (with gameMode)
 * @param {object[]} activeParticipants - List of active RoomParticipant
 * @returns {boolean}
 */
function shouldCloseRoomAfterRemoval(room, activeParticipants) {
	if (!room || !activeParticipants) return false;
	const count = activeParticipants.length;
	if (count === 0) return true;
	const gameMode = (room.gameMode || "1v1").toLowerCase();
	if (gameMode === "team_vs_team") {
		const byTeam = {};
		for (const p of activeParticipants) {
			const t = p.team || "unknown";
			byTeam[t] = (byTeam[t] || 0) + 1;
		}
		// Need at least 2 members per team (blue and orange). If any team has < 2, close.
		const teams = Object.keys(byTeam).filter((t) => t !== "unknown");
		for (const team of teams) {
			if (byTeam[team] < 2) return true;
		}
		// Also close if we don't have both teams with >= 2 (e.g. only one team left)
		if (teams.length < 2) return true;
		return false;
	}
	// 1v1
	return count <= 1;
}

// POST /report - Report a user in a room
router.post("/", async (req, res) => {
	const logTag = "Report";
	try {
		const userRequestingToBlockId = req.user.id;
		const { roomId: rawRoomId, userToBlockId: rawUserToBlockId, reportType: bodyReportType } = req.body;
		const reportType = bodyReportType === "user" ? "user" : "drawing";
		console.log(`[${logTag}] POST reportType=${reportType} roomId=${rawRoomId} userToBlockId=${rawUserToBlockId} by=${userRequestingToBlockId}`);

		const roomId = rawRoomId != null ? parseInt(String(rawRoomId), 10) : NaN;
		const userToBlockId = rawUserToBlockId != null ? parseInt(String(rawUserToBlockId), 10) : NaN;

		if (!Number.isFinite(roomId) || !Number.isFinite(userToBlockId)) {
			return res
				.status(400)
				.json({ error: "roomId and userToBlockId are required and must be valid numbers" });
		}

		const reportingUserParticipant = await RoomParticipant.findOne({
			where: { roomId, userId: userRequestingToBlockId, isActive: true },
		});

		if (!reportingUserParticipant) {
			return res.status(404).json({ error: "You are not in this room" });
		}

		const targetUserParticipant = await RoomParticipant.findOne({
			where: { roomId, userId: userToBlockId, isActive: true },
		});

		if (!targetUserParticipant) {
			return res
				.status(404)
				.json({ error: "User to report is not in this room" });
		}

		// Prevent self-reporting
		if (userRequestingToBlockId.toString() === userToBlockId.toString()) {
			return res.status(400).json({ error: "You cannot report yourself" });
		}

		// Find or create report entry (per reportType: 'user' and 'drawing' tracked separately).
		// Use transaction + row lock so concurrent reports from multiple players update count correctly (no lost updates).
		const reporterIdStr = userRequestingToBlockId.toString();
		let report;
		let newReportCount;
		try {
			await sequelize.transaction(async (t) => {
				report = await Report.findOne({
					where: { roomId, userToBlockId, reportType },
					lock: t.LOCK.UPDATE,
					transaction: t,
				});

				if (!report) {
					report = await Report.create({
						roomId,
						userToBlockId,
						reportType,
						reportedBy: [],
						reportCount: 0,
						strikeCount: 0,
					}, { transaction: t });
				}

				const reportedByArray = Array.isArray(report.reportedBy) ? [...report.reportedBy] : [];
				if (reportedByArray.includes(reporterIdStr)) {
					const err = new Error("You have already reported this user");
					err.statusCode = 400;
					throw err;
				}

				reportedByArray.push(reporterIdStr);
				newReportCount = reportedByArray.length;
				await report.update(
					{ reportedBy: reportedByArray, reportCount: newReportCount },
					{ transaction: t }
				);
			});
		} catch (err) {
			if (err.statusCode === 400) {
				return res.status(400).json({ error: err.message });
			}
			throw err;
		}

		const activeParticipantsCount = await RoomParticipant.count({
			where: { roomId, isActive: true }
		});

		const reportPercentage = (newReportCount / activeParticipantsCount) * 100;
		// Penalize: 3+ reports, OR 2+ reports with >=50% of room, OR 2-player room with 1+ report
		const shouldPenalize =
			newReportCount >= 3 ||
			(newReportCount >= 2 && reportPercentage >= 50) ||
			(activeParticipantsCount === 2 && newReportCount >= 1);

		if (shouldPenalize) {
			// Get room details
			const room = await Room.findByPk(roomId);
			if (!room) {
				return res.status(404).json({ error: "Room not found" });
			}
			const io = req.app.locals.io;

			// Report user (behavior): first time criteria met = exit from room immediately
			if (reportType === "user") {
				console.log(`[${logTag}] reportType=user penalize: removing user ${userToBlockId} from room ${roomId}`);
				const bannedUser = await User.findByPk(userToBlockId);
				const userName = bannedUser ? bannedUser.name : "User";
				const userSocketId = targetUserParticipant.socketId;

				await RoomParticipant.update(
					{ isActive: false, socketId: null, bannedAt: new Date() },
					{ where: { roomId, userId: userToBlockId } },
				);

				if (io) {
					if (userSocketId) {
						const userSocket = io.sockets.sockets.get(userSocketId);
						if (userSocket) {
							userSocket.leave(room.code);
							userSocket.emit("user_banned", {
								message: `You have been removed from this room due to reports. You cannot re-join`,
								roomId: roomId,
							});
						}
					}
					io.to(room.code).emit("user_banned_from_room", {
						message: `${userName} has been removed from the room due to reports`,
						bannedUserId: userToBlockId,
						roomId: roomId,
					});
					const activeParticipants = await RoomParticipant.findAll({
						where: { roomId, isActive: true },
						include: [{ model: User, as: "user", attributes: ["id", "name", "avatar", "coins"] }],
					});
					io.to(room.code).emit("room_participants", {
						participants: activeParticipants.map((p) => ({
							id: p.userId,
							name: p.user ? p.user.name : "Guest",
							avatar: p.user ? p.user.avatar : null,
							coins: p.user ? p.user.coins : 0,
							score: p.score,
							team: p.team,
							isDrawer: p.isDrawer,
							socketId: p.socketId,
							hasPaidEntry: p.hasPaidEntry,
						})),
					});
					// If not enough members left (1v1: <=1; team_vs_team: any team < 2), close room
					if (io && shouldCloseRoomAfterRemoval(room, activeParticipants)) {
						await deleteRoom(io, room);
					}
				}
				return res.json({
					success: true,
					message: "User reported and removed from room.",
					reportCount: newReportCount,
					banned: true,
				});
			}

			// Report drawing: 1st strike = abort drawing + next turn; 2nd strike = exit from room
			const currentStrikeCount = report.strikeCount ?? 0;

			if (currentStrikeCount === 0) {
				await report.update({ strikeCount: 1 });
				let aborted = false;
				if (io) {
					aborted = await abortDrawerForUser(io, room, userToBlockId);
					console.log(`[${logTag}] reportType=drawing first strike: abortDrawerForUser=${aborted}`);
				}
				return res.json({
					success: true,
					message: aborted
						? "Drawer reported. Their drawing turn has been aborted (first strike)."
						: "Drawer reported. First strike recorded.",
					reportCount: newReportCount,
					banned: false,
					strike: true,
					drawingAborted: aborted,
				});
			}

			// Second strike: ban from room and block re-join
			const bannedUser = await User.findByPk(userToBlockId);
			const userName = bannedUser ? bannedUser.name : "User";

			const userSocketId = targetUserParticipant.socketId;

			// Ban from this room only (bannedAt on this room's participant); user can still join other rooms
			await RoomParticipant.update(
				{ isActive: false, socketId: null, bannedAt: new Date() },
				{ where: { roomId, userId: userToBlockId } },
			);

			if (io) {
				// If user is connected via socket, kick them
				if (userSocketId) {
					const userSocket = io.sockets.sockets.get(userSocketId);
					if (userSocket) {
						userSocket.leave(room.code);
						userSocket.emit("user_banned", {
							message: `You have been banned from this room due to multiple reports. You cannot re-join`,
							roomId: roomId,
						});
					}
				}

				io.to(room.code).emit("user_banned_from_room", {
					message: `${userName} has been banned from the room for repeated reports`,
					bannedUserId: userToBlockId,
					roomId: roomId,
				});

				const activeParticipants = await RoomParticipant.findAll({
					where: { roomId, isActive: true },
					include: [
						{
							model: User,
							as: "user",
							attributes: ["id", "name", "avatar", "coins"],
						},
					],
				});
				io.to(room.code).emit("room_participants", {
					participants: activeParticipants.map((p) => ({
						id: p.userId,
						name: p.user ? p.user.name : "Guest",
						avatar: p.user ? p.user.avatar : null,
						coins: p.user ? p.user.coins : 0,
						score: p.score,
						team: p.team,
						isDrawer: p.isDrawer,
						socketId: p.socketId,
						hasPaidEntry: p.hasPaidEntry,
					})),
				});
				// If not enough members left (1v1: <=1; team_vs_team: any team < 2), close room
				if (io && shouldCloseRoomAfterRemoval(room, activeParticipants)) {
					await deleteRoom(io, room);
				}
			}

			console.log(
				`[${logTag}] reportType=drawing second strike: user ${userToBlockId} banned from room ${roomId} (${newReportCount} reports)`
			);

			return res.json({
				success: true,
				message: "User reported and banned from room. They cannot re-join.",
				reportCount: newReportCount,
				banned: true,
			});
		}

		// Report added but count not reached 3 yet
		console.log(`[${logTag}] reportType=${reportType} recorded reportCount=${newReportCount} (no penalty yet)`);
		return res.json({
			success: true,
			message: "User reported successfully",
			reportCount: newReportCount,
			banned: false,
		});
	} catch (err) {
		console.error("Report error:", err);
		res.status(500).json({ error: "server_error", message: err.message });
	}
});

module.exports = router;

