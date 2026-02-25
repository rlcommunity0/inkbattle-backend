const { Room, RoomParticipant } = require("../models");
const { clearRoomCache } = require("./roomCache");

async function deleteRoom(io, room) {
  try {
    clearRoomCache(room.id); // Invalidate cache so no stale reads after room is gone
    const { clearRoomTimer, clearAllPhaseTimersForRoom } = require("../sockets/roundPhases");
    console.log(`🗑 Deleting room: ${room.code}`);
    const roomCode = room.code;

    // 1. Notify all remaining sockets first (so all players get "room ended" before cleanup)
    io.to(roomCode).emit("room_closed", { roomCode, message: "Host left. Room closed." });

    // 2. Clear timers
    // clearRoomTimer(`${roomCode}_phase`);
    // clearRoomTimer(`${roomCode}_drawing`);
    clearAllPhaseTimersForRoom(roomCode);

    // 3. Force all sockets out
    const sockets = await io.in(roomCode).fetchSockets();

    for (const s of sockets) {
      s.emit("room_closed", { roomCode, message: "Room has been closed."});
      s.leave(roomCode);

      // Room will be deleted, so we need to clear the room from the socket
      s.currentRoom = null;
      s.roomId = null;
      s.roomCode = null;
    }

    // 4. Remove participants and room
    await RoomParticipant.destroy({ where: { roomId: room.id } });
    await room.destroy();

    return true;
  } catch (err) {
    console.error("Room deletion error:", err);
    return false;
  }
}

async function checkAndMaybeDeleteRoom(io, roomId) {
  const room = await Room.findByPk(roomId);
  if (!room) return;

  const participants = await RoomParticipant.findAll({
    where: { roomId, isActive: true },
  });

  const count = participants.length;

  // ❌ Case 1: No players
  if (count === 0) {
    return deleteRoom(io, room);
  }

  // ❌ Case 2: Owner not present
  const ownerPresent = participants.some((p) => p.userId === room.ownerId);
  if (!ownerPresent) {
    return deleteRoom(io, room);
  }
}

module.exports = { deleteRoom, checkAndMaybeDeleteRoom };

