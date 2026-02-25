/**
 * In-memory ready state per room (lobby). Cleared on game start and when room goes back to lobby.
 * Key: roomId, Value: Set of userIds who have tapped Ready.
 */
const roomReadySets = new Map();

function getSet(roomId) {
	if (!roomReadySets.has(roomId)) {
		roomReadySets.set(roomId, new Set());
	}
	return roomReadySets.get(roomId);
}

function setReady(roomId, userId) {
	getSet(roomId).add(userId);
}

function removeReady(roomId, userId) {
	const set = roomReadySets.get(roomId);
	if (set) set.delete(userId);
}

function isReady(roomId, userId) {
	const set = roomReadySets.get(roomId);
	return set ? set.has(userId) : false;
}

function clearRoom(roomId) {
	roomReadySets.delete(roomId);
}

function areAllReady(roomId, participantUserIds) {
	if (!participantUserIds || participantUserIds.length === 0) return false;
	const set = roomReadySets.get(roomId);
	if (!set) return false;
	return participantUserIds.every((id) => set.has(id));
}

module.exports = {
	setReady,
	removeReady,
	isReady,
	clearRoom,
	areAllReady,
};

