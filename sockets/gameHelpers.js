const {
	Room,
	RoomParticipant,
	User,
	Word,
	CoinTransaction,
} = require("../models");
const readyState = require("./readyState");

// Phase durations in seconds
const PHASE_DURATIONS = {
	selecting_drawer: 5,
	choosing_word: 10,
	drawing: 80,
	reveal: 7,
	interval: 4,
	lobby_timeout: 2 * 60, //2 min
};

// Calculate entry cost
// Entry cost is exactly the configured points value (no voice bonus)
function calculateEntryCost(entryPoints, voiceEnabled) {
	return entryPoints;
}

// Calculate reward based on remaining time
function calculateGuessReward(remainingTime, maxPoints) {
	return Math.min(Math.ceil(remainingTime / 8), maxPoints);
}

// Calculate time reduction after correct guess
function calculateTimeReduction(remainingTime, numPlayers) {
	return Math.floor(remainingTime / numPlayers);
}

/**
 * High-precision score update helper
 * Updates participant score and refreshes points_updated_at timestamp for tie-breaking
 * @param {RoomParticipant} participant - The participant to update
 * @param {number} pointsToAdd - Points to add to current score
 * @returns {Promise<void>}
 */
async function updateParticipantScore(participant, pointsToAdd) {
	participant.score += pointsToAdd;
	participant.points_updated_at = new Date(); // High-precision timestamp for tie-breaking
	await participant.save();
}

// Check if game should end (someone reached target)
async function checkGameEnd(io, room) {
	// High-precision tie-breaking: Sort by score DESC, then points_updated_at ASC
	// (earlier timestamp = reached score first = higher rank)
	const participants = await RoomParticipant.findAll({
		where: { roomId: room.id, isActive: true },
		include: [{ model: User, as: "user" }],
		order: [
			["score", "DESC"],
			["points_updated_at", "ASC"], // Earlier timestamp = higher rank
		],
	});

	const winner = participants.find((p) => p.score >= room.targetPoints);

	if (winner) {
		// Pass participants to endGame (will be reloaded there for final accuracy)
		await endGame(io, room, participants);
		return true;
	}

	return false;
}

// End game and award coins
// SEQUENTIAL GAME-END LIFECYCLE:
// 1. Update Drawer Score (already done in endDrawingPhase)
// 2. Update Guesser Score (already done in submit_guess)
// 3. Finalize Leaderboard (this function) - Calculate final unique ranks
// 4. Sync State - Broadcast final scores to frontend
// 5. Trigger UI - Frontend shows "Game Over" popup after receiving final data
async function endGame(io, room, participants) {
	try {
		// STEP 1: Mark room as finished (prevents further score updates)
		room.status = "finished";
		await room.save();

		// STEP 2: Reload participants with latest scores and timestamps for accurate ranking
		// This ensures we have the most up-to-date data after all score updates
		const finalParticipants = await RoomParticipant.findAll({
			where: { roomId: room.id, isActive: true },
			include: [{ model: User, as: "user" }],
			order: [
				["score", "DESC"],
				["points_updated_at", "ASC"], // High-precision tie-breaking
			],
		});

		const entryCost = calculateEntryCost(room.entryPoints, room.voiceEnabled);
		const rankings = [];
		const gameMode = room.gameMode || "1v1";

		if (gameMode === "team_vs_team") {
			// TEAM VS TEAM MODE: Award coins only to winning team members
			// Group participants by team
			const teamScores = {};
			const teamMembers = {};

			for (const participant of finalParticipants) {
				const team = participant.team;
				if (!team) continue; // Skip participants without team

				if (!teamScores[team]) {
					teamScores[team] = participant.score;
					teamMembers[team] = [];
				}
				// In team mode, all team members have the same score (team score)
				teamMembers[team].push(participant);
			}

			// Find winning team (highest score)
			const teams = Object.keys(teamScores);
			if (teams.length === 0) {
				console.error("No teams found in team_vs_team mode");
				return;
			}

			// Sort teams by score (descending)
			teams.sort((a, b) => teamScores[b] - teamScores[a]);
			const winningTeam = teams[0];
			const winningScore = teamScores[winningTeam];

			// Handle ties: If multiple teams have same score, first team in sorted order wins
			// (This is optimal as it maintains consistency based on team order)
			const winningTeamMembers = teamMembers[winningTeam] || [];

			// Award coins to ALL members of winning team (1st place reward)
			const coinsAwarded = entryCost * 2; // winning team multiplier

			for (const participant of winningTeamMembers) {
				const user = await User.findByPk(participant.userId);
				if (user) {
					user.coins += coinsAwarded;
					await user.save();

					await CoinTransaction.create({
						userId: user.id,
						amount: coinsAwarded,
						reason: `game_reward_team_vs_team_winner`,
					});

					rankings.push({
						place: 1,
						userId: participant.userId,
						name: participant.user?.name || "Guest",
						score: participant.score,
						coinsAwarded,
						team: participant.team,
					});

					console.log(
						`Team Winner: ${participant.user?.name} (Team: ${winningTeam}) - ${participant.score} points, ${coinsAwarded} coins`,
					);
				}
			}

			// Add losing team members without rewards
			for (let i = 1; i < teams.length; i++) {
				const team = teams[i];
				const teamMembersList = teamMembers[team] || [];
				for (const participant of teamMembersList) {
					rankings.push({
						place: i + 1,
						userId: participant.userId,
						name: participant.user?.name || "Guest",
						score: participant.score,
						coinsAwarded: 0,
						team: participant.team,
					});
				}
			}

			// Add any participants without team (shouldn't happen, but handle gracefully)
			for (const participant of finalParticipants) {
				if (!participant.team) {
					rankings.push({
						place: teams.length + 1,
						userId: participant.userId,
						name: participant.user?.name || "Guest",
						score: participant.score,
						coinsAwarded: 0,
						team: null,
					});
				}
			}
		} else {
			// 1V1 MODE: Award coins to top 3 players with strict unique rankings
			// High-precision tie-breaking: Sort by score DESC, then points_updated_at ASC
			// (earlier timestamp = reached score first = higher rank)
			// This ensures NO two players ever share the same rank
			// Note: finalParticipants are already sorted by DB query, but we ensure consistency here
			finalParticipants.sort((a, b) => {
				// Primary sort: Score (descending)
				if (b.score !== a.score) {
					return b.score - a.score;
				}
				// Secondary sort: points_updated_at (ascending - earlier = higher rank)
				const timeA = a.points_updated_at ? new Date(a.points_updated_at).getTime() : 0;
				const timeB = b.points_updated_at ? new Date(b.points_updated_at).getTime() : 0;
				return timeA - timeB; // Earlier timestamp wins (ASC order)
			});

			const rewards = [
				{ place: 1, multiplier: 3 },
				{ place: 2, multiplier: 2 },
				{ place: 3, multiplier: 1 },
			];

			// STRICT RANKING: Each place (1st, 2nd, 3rd) is assigned to exactly ONE player
			// 2-player 1v1: winner 2*entry, loser 0; 3+ players: 3x, 2x, 1x
			const isTwoPlayer = finalParticipants.length === 2;
			for (let i = 0; i < Math.min(finalParticipants.length, 3); i++) {
				const participant = finalParticipants[i];
				const currentPlace = i + 1; // Strict sequential ranking: 1, 2, 3
				const reward = rewards[i];
				const coinsAwarded = isTwoPlayer
					? (currentPlace === 1 ? entryCost * 2 : 0)
					: entryCost * reward.multiplier;

				const user = await User.findByPk(participant.userId);
				if (user) {
					if (coinsAwarded > 0) {
						user.coins += coinsAwarded;
						await user.save();
						await CoinTransaction.create({
							userId: user.id,
							amount: coinsAwarded,
							reason: `game_reward_place_${currentPlace}`,
						});
					}

					rankings.push({
						place: currentPlace,
						userId: participant.userId,
						name: participant.user?.name || "Guest",
						score: participant.score,
						coinsAwarded,
					});

					console.log(
						`🏆 Place ${currentPlace}: ${participant.user?.name} - ${participant.score} points (updated: ${participant.points_updated_at}), ${coinsAwarded} coins`,
					);
				}
			}

			// Add remaining players without rewards (ranked 4th or lower)
			for (let i = 3; i < finalParticipants.length; i++) {
				const participant = finalParticipants[i];
				rankings.push({
					place: i + 1,
					userId: participant.userId,
					name: participant.user?.name || "Guest",
					score: participant.score,
					coinsAwarded: 0,
				});
			}
		}

		// STEP 3: Sync State - Broadcast final, sorted rankings to frontend
		// Frontend will only show "Game Over" popup after receiving this final data
		io.to(room.code).emit("game_ended", {
			rankings, // Final rankings with strict unique places (1, 2, 3)
			entryCost,
			gameMode,
		});

		setTimeout(async () => {
			room.status = "lobby";
			await room.save();
			// Reset participant scores so next game starts from 0
			await RoomParticipant.update(
				{ score: 0 },
				{ where: { roomId: room.id } },
			);
			readyState.clearRoom(room.id); // Clear ready state so everyone must tap Ready again
			// Notify all participants so every client can show lobby (regardless of ad order)
			io.to(room.code).emit("room_back_to_lobby", { roomId: room.id, status: "lobby" });
		}, 2000);

		console.log(`Game ended in room ${room.code} (Mode: ${gameMode})`);
	} catch (e) {
		console.error("End game error:", e);
	}
}

module.exports = {
	PHASE_DURATIONS,
	calculateEntryCost,
	calculateGuessReward,
	calculateTimeReduction,
	updateParticipantScore,
	checkGameEnd,
	endGame,
};


