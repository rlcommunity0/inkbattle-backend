/**
 * Read-through room cache: minimal snapshot only (never Sequelize instances long-term).
 * DB remains source of truth. Cache serves reads; all writes refresh cache.
 * TTL prevents rare stale data; roomCodeIndex avoids DB lookup by code.
 */
const { Room } = require("../models");

const roomCache = new Map(); // roomId -> { data, ts }
const roomCodeIndex = new Map(); // code -> roomId

const TTL_MS = Number(process.env.ROOM_CACHE_TTL_MS) || 5000; // 5s default

function minimal(room) {
	if (!room) return null;
	return {
		id: room.id,
		code: room.code,
		roundPhase: room.roundPhase,
		roundPhaseEndTime: room.roundPhaseEndTime,
		roundRemainingTime: room.roundRemainingTime,
	};
}

/**
 * DB authority: always load from DB, then refresh cache. Returns fresh Sequelize instance.
 * Use for writes, save(), or when passing room to functions that need the full model.
 */
async function getRoom(roomId) {
	const room = await Room.findByPk(roomId);
	if (room) refreshRoomCache(room);
	return room;
}

/**
 * Fast read: return cached minimal snapshot if present and not expired; else load from DB and cache.
 * Returns plain object { id, code, roundPhase, roundPhaseEndTime, roundRemainingTime } or null.
 * Use for phase checks, timer "should I run?" — then call getRoom(roomId) only when running callback.
 */
async function getRoomCached(roomId) {
	const entry = roomCache.get(roomId);
	if (entry && Date.now() - entry.ts < TTL_MS) {
		return entry.data;
	}
	const room = await Room.findByPk(roomId);
	if (!room) return null;
	refreshRoomCache(room);
	return minimal(room);
}

/**
 * Refresh cache after ANY DB write (transitionPhase, room.save(), Room.update).
 * Never store Sequelize model in cache — only minimal snapshot.
 */
function refreshRoomCache(room) {
	if (!room || room.id == null) return;
	const data = minimal(room);
	roomCache.set(room.id, { data, ts: Date.now() });
	if (room.code != null) roomCodeIndex.set(room.code, room.id);
}

/**
 * Update cache with minimal snapshot by id (e.g. after transitionPhase when you have roomId + room).
 * Prefer refreshRoomCache(room) when you have the room instance.
 */
function setRoomCacheMinimal(roomId, room) {
	if (roomId == null || !room) return;
	refreshRoomCache(room);
}

/**
 * Load room by code: try cache index first (O(1)), else DB. Updates cache and index.
 * Use in join_room, start_game, etc. to avoid Room.findOne({ where: { code } }) when cached.
 */
async function getRoomByCode(code) {
	if (!code) return null;
	const roomId = roomCodeIndex.get(code);
	if (roomId != null) {
		const room = await Room.findByPk(roomId);
		if (room) {
			refreshRoomCache(room);
			return room;
		}
		roomCodeIndex.delete(code);
	}
	const room = await Room.findOne({ where: { code } });
	if (room) refreshRoomCache(room);
	return room;
}

/**
 * Clear cache for a room (call on deleteRoom, room closed, server restart).
 */
function clearRoomCache(roomId) {
	if (roomId == null) return;
	const entry = roomCache.get(roomId);
	if (entry && entry.data && entry.data.code != null) {
		roomCodeIndex.delete(entry.data.code);
	}
	roomCache.delete(roomId);
}

/**
 * O(1) lookup: get room id by code. Returns undefined if not in cache.
 * Use with getRoomCached(id) or getRoom(id) to avoid Room.findOne({ where: { code } }).
 */
function getRoomIdByCode(code) {
	return roomCodeIndex.get(code);
}

module.exports = {
	getRoom,
	getRoomCached,
	getRoomByCode,
	refreshRoomCache,
	setRoomCacheMinimal,
	clearRoomCache,
	getRoomIdByCode,
};

