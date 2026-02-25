/**
 * O(1) userId -> socketId map for single-session enforcement and sending to current socket.
 * Updated on connection/disconnect in socket.js; used by roundPhases when sending word_options
 * so the drawer gets word_options on their live socket after reconnect.
 */
const userSocketMap = new Map();

function getSocketIdForUser(userId) {
	if (userId == null) return undefined;
	return userSocketMap.get(userId);
}

function setSocketForUser(userId, socketId) {
	if (userId == null) return;
	userSocketMap.set(userId, socketId);
}

function deleteUser(userId) {
	if (userId == null) return;
	userSocketMap.delete(userId);
}

/**
 * Emit to a user's current socket (resolve right before send — prevents "arrive while sending" race).
 * Single source of truth = userSocketMap. Use this for all single-user emits.
 * @returns {boolean} true if emitted, false if no socket for user
 */
function emitToUser(io, userId, event, payload) {
	if (userId == null || !io) return false;
	const socketId = getSocketIdForUser(userId);
	if (!socketId) return false;
	io.to(socketId).emit(event, payload);
	return true;
}

module.exports = {
	userSocketMap,
	getSocketIdForUser,
	setSocketForUser,
	deleteUser,
	emitToUser,
};

