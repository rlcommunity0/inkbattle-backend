/*
Socket.IO handlers for InkBattle Game
Real-time features:
- Room management (join/leave)
- Drawing broadcast
- Chat (global room chat)
- Guess submission and validation
- Game round management
- WebRTC voice signaling

Client Events:
  join_room { roomCode }
  leave_room { roomCode }
  start_game { roomCode }
  drawing_data { roomCode, strokes }
  clear_canvas { roomCode }
  chat_message { roomCode, content }
  submit_guess { roomCode, guess }
  webrtc_offer / webrtc_answer / webrtc_ice { to, data, roomCode }

Server Events:
  room_joined { room, participants }
  room_participants { participants }
  game_started { room }
  round_started { round, drawer, word, wordHint, duration }
  drawing_data { strokes, from }
  canvas_cleared
  chat_message { id, content, user, createdAt, type }
  correct_guess { by, word, participant }
  round_ended { reason, word, nextDrawer }
  game_ended { winner, finalScores }
  error { message }
*/

const { verify } = require('../utils/auth');
const { Room, RoomParticipant, User, Message, CoinTransaction, Word, Theme } = require('../models');

// Store active timers for rooms
const roomTimers = new Map();

module.exports = function(io) {
  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(); // allow anonymous
    const payload = verify(token);
    if (payload) socket.user = payload;
    next();
  });

  io.on('connection', (socket) => {
    console.log('✅ Socket connected:', socket.id, socket.user ? `User: ${socket.user.name}` : 'anonymous');

    // JOIN ROOM
    socket.on('join_room', async ({ roomCode, roomId }) => {
      try {
        // Support both roomCode and roomId
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        
        if (!room) {
          return socket.emit('error', { message: 'room_not_found' });
        }

        socket.join(room.code);
        socket.currentRoom = room.code;

        // Update participant socket ID
        if (socket.user) {
          await RoomParticipant.update(
            { socketId: socket.id, isActive: true },
            { where: { roomId: room.id, userId: socket.user.id } }
          );
        }

        // Get all active participants
        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar'] }]
        });

        const participantList = participants.map(p => ({
          id: p.userId,
          name: p.user ? p.user.name : 'Guest',
          avatar: p.user ? p.user.avatar : null,
          score: p.score,
          team: p.team,
          isDrawer: p.isDrawer,
          socketId: p.socketId
        }));

        // Send room state to joiner
        socket.emit('room_joined', {
          room: {
            id: room.id,
            code: room.isPublic ? undefined : room.code, // Only show code for private rooms
            name: room.name,
            status: room.status,
            roomType: room.roomType,
            category: room.category,
            voiceEnabled: room.voiceEnabled,
            currentRound: room.currentRound,
            maxPlayers: room.maxPlayers
          },
          participants: participantList
        });

        // Broadcast updated participant list to room
        io.to(room.code).emit('room_participants', { participants: participantList });
        
        // Notify others that a player joined
        socket.to(room.code).emit('player_joined', {
          userName: socket.user ? socket.user.name : 'Guest',
          userId: socket.user ? socket.user.id : null
        });

        console.log(`👤 User ${socket.user ? socket.user.name : 'Guest'} joined room ${room.code}`);
      } catch (e) {
        console.error('Join room error:', e);
        socket.emit('error', { message: 'join_room_failed' });
      }
    });

    // START GAME
    socket.on('start_game', async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (!room) return socket.emit('error', { message: 'room_not_found' });

        // Only owner can start
        if (room.ownerId !== socket.user?.id) {
          return socket.emit('error', { message: 'only_owner_can_start' });
        }

        if (room.status !== 'waiting') {
          return socket.emit('error', { message: 'game_already_started' });
        }

        // Update room status
        room.status = 'playing';
        room.currentRound = 1;
        await room.save();

        io.to(room.code).emit('game_started', { room: { status: room.status } });

        // Start first round
        await startNewRound(io, room);
      } catch (e) {
        console.error('Start game error:', e);
        socket.emit('error', { message: 'start_game_failed' });
      }
    });

    // DRAWING DATA
    socket.on('drawing_data', async ({ roomCode, roomId, strokes }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (room) {
          socket.to(room.code).emit('drawing_data', { strokes, from: socket.id });
        }
      } catch (e) {
        console.error('Drawing data error:', e);
      }
    });

    // CLEAR CANVAS
    socket.on('clear_canvas', async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (room) {
          io.to(room.code).emit('canvas_cleared', { by: socket.user ? socket.user.name : 'Someone' });
        }
      } catch (e) {
        console.error('Clear canvas error:', e);
      }
    });

    // CHAT MESSAGE
    socket.on('chat_message', async ({ roomCode, roomId, content }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        if (!room) return;

        const userId = socket.user ? socket.user.id : null;
        const msg = await Message.create({
          roomId: room.id,
          userId,
          content,
          type: 'text'
        });

        // Fetch user from database to get name
        let user = { id: null, name: 'Guest', avatar: null };
        if (userId) {
          const dbUser = await User.findByPk(userId);
          if (dbUser) {
            user = {
              id: dbUser.id,
              name: dbUser.name,
              avatar: dbUser.avatar
            };
          }
        }

        io.to(room.code).emit('chat_message', {
          id: msg.id,
          content: msg.content,
          user,
          createdAt: msg.createdAt,
          type: 'text'
        });
      } catch (e) {
        console.error('Chat message error:', e);
      }
    });

    // SUBMIT GUESS
    socket.on('submit_guess', async ({ roomCode, roomId, guess }) => {
      try {
        console.log(`🎯 Guess submitted - User: ${socket.user ? socket.user.id : 'anonymous'}, Guess: ${guess}, RoomId: ${roomId}, RoomCode: ${roomCode}`);
        
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        
        if (!room) {
          console.log(`❌ Room not found for guess submission`);
          return socket.emit('guess_result', { ok: false, message: 'room_not_found' });
        }
        
        if (!room.currentWord) {
          console.log(`❌ No active word in room ${room.id}`);
          return socket.emit('guess_result', { ok: false, message: 'no_active_word' });
        }

        console.log(`📝 Current word: ${room.currentWord}, Room: ${room.id}`);

        // Check if user is authenticated
        if (!socket.user || !socket.user.id) {
          console.log(`❌ User not authenticated for guess submission`);
          return socket.emit('guess_result', { ok: false, message: 'not_authenticated' });
        }

        // Check if user is the drawer (drawer can't guess)
        const participant = await RoomParticipant.findOne({
          where: { roomId: room.id, userId: socket.user.id }
        });
        
        if (!participant) {
          console.log(`❌ Participant not found for user ${socket.user.id} in room ${room.id}`);
          return socket.emit('guess_result', { ok: false, message: 'not_in_room' });
        }
        
        if (participant.isDrawer) {
          console.log(`❌ User ${socket.user.id} is the drawer, cannot guess`);
          return socket.emit('guess_result', { ok: false, message: 'drawer_cannot_guess' });
        }

        const normalized = (guess || '').toString().trim().toLowerCase();
        const word = room.currentWord.toString().trim().toLowerCase();
        const isCorrect = normalized === word;

        console.log(`🔍 Comparing: "${normalized}" === "${word}" = ${isCorrect}`);

        if (isCorrect) {
          console.log(`✅ Correct guess by user ${socket.user.id}`);
          
          // Award coins and update score
          const user = await User.findByPk(socket.user.id);

          if (user && participant) {
            user.coins += 20;
            participant.score += 20;
            await user.save();
            await participant.save();
            
            console.log(`💰 Awarded 20 coins to user ${socket.user.id}, new score: ${participant.score}`);
            
            await CoinTransaction.create({
              userId: user.id,
              amount: 20,
              reason: 'correct_guess'
            });

            // Broadcast correct guess
            io.to(room.code).emit('correct_guess', {
              by: { id: socket.user.id, name: socket.user.name },
              word: room.currentWord,
              participant: {
                id: participant.userId,
                name: socket.user.name,
                score: participant.score
              }
            });
            
            console.log(`📢 Broadcasted correct_guess event to room ${room.code}`);

            // Send system message
            const systemMsg = await Message.create({
              roomId: room.id,
              userId: null,
              content: `${socket.user.name} guessed the word correctly!`,
              type: 'system'
            });

            io.to(room.code).emit('chat_message', {
              id: systemMsg.id,
              content: systemMsg.content,
              user: { id: null, name: 'System', avatar: null },
              createdAt: systemMsg.createdAt,
              type: 'system'
            });

            // End round and start next
            clearRoomTimer(room.code);
            setTimeout(() => startNewRound(io, room), 3000);
          }
        } else {
          console.log(`❌ Incorrect guess: "${normalized}" !== "${word}"`);
          socket.emit('guess_result', { ok: false, message: 'incorrect' });
        }
      } catch (e) {
        console.error('Submit guess error:', e);
      }
    });

    // WEBRTC SIGNALING
    socket.on('webrtc_offer', ({ to, data, roomCode }) => {
      io.to(to).emit('webrtc_offer', { from: socket.id, data });
    });

    socket.on('webrtc_answer', ({ to, data, roomCode }) => {
      io.to(to).emit('webrtc_answer', { from: socket.id, data });
    });

    socket.on('webrtc_ice', ({ to, data, roomCode }) => {
      io.to(to).emit('webrtc_ice', { from: socket.id, data });
    });

    // --- Voice Channel Events ---

// 1. User attempts to join the voice channel
socket.on('join_voice', ({ roomId, userId }) => {
    if (!roomId || !userId) return;

    // Initialize room if it doesn't exist
    if (!voiceRooms.has(roomId)) {
        voiceRooms.set(roomId, new Map());
    }

    const participants = voiceRooms.get(roomId);
    
    // Create payload list for the new user
    const participantList = [];
    
    // Notify existing participants about the new user
    participants.forEach((socketId, pUserId) => {
        // Build the list for the new user
        participantList.push({ userId: pUserId, socketId: socketId });

        // Notify existing users
        if (pUserId !== userId) {
            io.to(socketId).emit('user_joined_voice', {
                userId: userId,
                socketId: socket.id
            });
        }
    });

    // Add the current user to the voice room map
    participants.set(userId, socket.id);
    
    // Emit the list of existing participants back to the new user
    socket.emit('voice_participants', { participants: participantList });

    console.log(`🎤 User ${userId} joined voice in room ${roomId}. Total: ${participants.size}`);
});

// 2. User leaves the voice channel explicitly
socket.on('leave_voice', ({ roomId, userId }) => {
    if (!roomId || !userId) return;

    const participants = voiceRooms.get(roomId);
    if (!participants) return;

    // Remove user from the map
    participants.delete(userId);

    // Notify all remaining participants
    participants.forEach((socketId) => {
        io.to(socketId).emit('user_left_voice', {
            userId: userId,
            socketId: socket.id
        });
    });

    console.log(`🔌 User ${userId} left voice in room ${roomId}. Total: ${participants.size}`);

    // Cleanup empty room
    if (participants.size === 0) {
        voiceRooms.delete(roomId);
    }
});

// 3. User requests a list of current participants (used by the client after enabling mic)
socket.on('get_voice_participants', ({ roomId }) => {
    if (!roomId) return;

    const participants = voiceRooms.get(roomId);
    if (!participants) return;

    const participantList = [];
    participants.forEach((socketId, userId) => {
        participantList.push({ userId, socketId });
    });

    socket.emit('voice_participants', { participants: participantList });
});
    // LEAVE ROOM
    socket.on('leave_room', async ({ roomCode, roomId }) => {
      try {
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        
        if (room) {
          socket.leave(room.code);
          
          if (socket.user) {
            await RoomParticipant.update(
              { isActive: false, socketId: null },
              { where: { roomId: room.id, userId: socket.user.id } }
            );

            console.log(`👋 User ${socket.user.name} left room ${room.code}`);

            // Check if room is now empty and close it
            const roomClosed = await checkAndCloseEmptyRoom(room.id);
            
            if (!roomClosed) {
              // Room still has participants, broadcast updated list
              const participants = await RoomParticipant.findAll({
                where: { roomId: room.id, isActive: true },
                include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar'] }]
              });

              io.to(room.code).emit('room_participants', {
                participants: participants.map(p => ({
                  id: p.userId,
                  name: p.user ? p.user.name : 'Guest',
                  score: p.score,
                  team: p.team
                }))
              });
            } else {
              // Room was closed, notify any remaining sockets
              io.to(room.code).emit('room_closed', { 
                message: 'Room closed - no active participants' 
              });
            }
          }
        }
      } catch (e) {
        console.error('Leave room error:', e);
      }
    });

    // DISCONNECT
    socket.on('disconnect', async () => {
      console.log('❌ Socket disconnected:', socket.id);
      
      // Mark user as inactive if they were in a room
      if (socket.user && socket.currentRoom) {
        try {
          const room = await Room.findOne({ where: { code: socket.currentRoom } });
          if (room) {
            await RoomParticipant.update(
              { isActive: false, socketId: null },
              { where: { roomId: room.id, userId: socket.user.id } }
            );

            console.log(`👋 User ${socket.user.name} disconnected from room ${room.code}`);

            // Check if room is now empty and close it
            const roomClosed = await checkAndCloseEmptyRoom(room.id);
            
            if (!roomClosed) {
              // Room still has participants, broadcast updated list
              const participants = await RoomParticipant.findAll({
                where: { roomId: room.id, isActive: true },
                include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar'] }]
              });

              io.to(room.code).emit('room_participants', {
                participants: participants.map(p => ({
                  id: p.userId,
                  name: p.user ? p.user.name : 'Guest',
                  score: p.score,
                  team: p.team
                }))
              });
            } else {
              // Room was closed, notify any remaining sockets
              io.to(room.code).emit('room_closed', { 
                message: 'Room closed - no active participants' 
              });
            }
          }
        } catch (e) {
          console.error('Disconnect cleanup error:', e);
        }
      }
    });
  });
};

// HELPER FUNCTIONS

// Check if room is empty and close it if needed
async function checkAndCloseEmptyRoom(roomId) {
  try {
    const activeParticipants = await RoomParticipant.count({
      where: { roomId: roomId, isActive: true }
    });

    if (activeParticipants === 0) {
      // No active participants left, close the room
      await Room.update(
        { status: 'closed' },
        { where: { id: roomId } }
      );
      
      // Clear any room timers
      const room = await Room.findByPk(roomId);
      if (room) {
        clearRoomTimer(room.code);
        console.log(`🏠 Room ${roomId} (${room.name}) closed - no active participants`);
      }
      
      return true; // Room was closed
    }
    
    return false; // Room still has participants
  } catch (error) {
    console.error('Error checking empty room:', error);
    return false;
  }
}

// Start a new round
async function startNewRound(io, room) {
  try {
    // Get active participants
    const participants = await RoomParticipant.findAll({
      where: { roomId: room.id, isActive: true },
      include: [{ model: User, as: 'user' }]
    });

    if (participants.length < 2) {
      io.to(room.code).emit('error', { message: 'not_enough_players' });
      return;
    }

    // Reset all participants' drawer status
    await RoomParticipant.update(
      { isDrawer: false },
      { where: { roomId: room.id } }
    );

    // Select next drawer (round-robin)
    let nextDrawer;
    if (room.currentDrawerId) {
      const currentIndex = participants.findIndex(p => p.userId === room.currentDrawerId);
      const nextIndex = (currentIndex + 1) % participants.length;
      nextDrawer = participants[nextIndex];
    } else {
      nextDrawer = participants[0];
    }

    // Mark as drawer
    nextDrawer.isDrawer = true;
    await nextDrawer.save();

    // Get random word from theme
    let word = null;
    if (room.themeId) {
      const words = await Word.findAll({ where: { themeId: room.themeId } });
      if (words.length > 0) {
        word = words[Math.floor(Math.random() * words.length)];
      }
    }

    if (!word) {
      // Fallback words
      const fallbackWords = ['apple', 'banana', 'cat', 'dog', 'elephant', 'flower', 'guitar', 'house'];
      const randomWord = fallbackWords[Math.floor(Math.random() * fallbackWords.length)];
      word = { text: randomWord };
    }

    // Update room
    room.currentWord = word.text;
    room.currentDrawerId = nextDrawer.userId;
    room.roundStartTime = new Date();
    await room.save();

    // Create word hint (show length)
    const wordHint = word.text.split('').map(() => '_').join(' ');

    // Emit round started
    io.to(room.code).emit('round_started', {
      round: room.currentRound,
      drawer: {
        id: nextDrawer.userId,
        name: nextDrawer.user ? nextDrawer.user.name : 'Guest'
      },
      word: word.text, // Only drawer sees this
      wordHint, // Everyone sees this
      duration: room.roundDuration
    });

    // Start round timer (120 seconds)
    const timer = setTimeout(async () => {
      await endRound(io, room, 'timeout');
    }, 120 * 1000);

    roomTimers.set(room.code, timer);

    console.log(`🎮 Round ${room.currentRound} started in room ${room.code}, drawer: ${nextDrawer.user?.name}`);
  } catch (e) {
    console.error('Start new round error:', e);
  }
}

// End current round
async function endRound(io, room, reason = 'timeout') {
  try {
    clearRoomTimer(room.code);

    io.to(room.code).emit('round_ended', {
      reason,
      word: room.currentWord
    });

    // Increment round
    room.currentRound += 1;
    room.currentWord = null;
    await room.save();

    // Start next round after delay
    setTimeout(() => startNewRound(io, room), 5000);
  } catch (e) {
    console.error('End round error:', e);
  }
}

// Clear room timer
function clearRoomTimer(roomCode) {
  if (roomTimers.has(roomCode)) {
    clearTimeout(roomTimers.get(roomCode));
    roomTimers.delete(roomCode);
  }
}
