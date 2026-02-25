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

const { verify } = require('../utils/auth');
const { Room, RoomParticipant, User, Message, CoinTransaction, Theme } = require('../models');
const { calculateEntryCost, calculateGuessReward, calculateTimeReduction } = require('./gameHelpers');
const { startNewRound, startDrawingPhase, clearRoomTimer } = require('./roundPhases');

module.exports = function(io) {
  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next();
    const payload = verify(token);
    if (payload) socket.user = payload;
    next();
  });

  io.on('connection', (socket) => {
    console.log('✅ Socket connected:', socket.id, socket.user ? `User: ${socket.user.name}` : 'anonymous');

    // JOIN ROOM
    socket.on('join_room', async ({ roomCode, roomId }) => {
      try {
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

        if (socket.user) {
          await RoomParticipant.update(
            { socketId: socket.id, isActive: true },
            { where: { roomId: room.id, userId: socket.user.id } }
          );
        }

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
          socketId: p.socketId,
          hasPaidEntry: p.hasPaidEntry
        }));

        socket.emit('room_joined', {
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
            roundRemainingTime: room.roundRemainingTime
          },
          participants: participantList
        });

        io.to(room.code).emit('room_participants', { participants: participantList });
        
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

    // UPDATE SETTINGS (Owner only, lobby only)
    socket.on('update_settings', async ({ roomId, settings }) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room) return socket.emit('error', { message: 'room_not_found' });

        if (room.ownerId !== socket.user?.id) {
          return socket.emit('error', { message: 'only_owner_can_update' });
        }

        if (room.status !== 'lobby') {
          return socket.emit('error', { message: 'cannot_update_after_game_started' });
        }

        if (settings.gameMode !== undefined) room.gameMode = settings.gameMode;
        if (settings.language !== undefined) room.language = settings.language;
        if (settings.script !== undefined) room.script = settings.script;
        if (settings.country !== undefined) room.country = settings.country;
        if (settings.category !== undefined) {
          room.category = settings.category;
          const theme = await Theme.findOne({ where: { title: settings.category } });
          room.themeId = theme ? theme.id : null;
        }
        if (settings.entryPoints !== undefined) room.entryPoints = settings.entryPoints;
        if (settings.targetPoints !== undefined) room.targetPoints = settings.targetPoints;
        if (settings.voiceEnabled !== undefined) room.voiceEnabled = settings.voiceEnabled;
        if (settings.isPublic !== undefined) room.isPublic = settings.isPublic;
        if (settings.maxPlayers !== undefined) room.maxPlayers = settings.maxPlayers;

        await room.save();

        io.to(room.code).emit('settings_updated', {
          gameMode: room.gameMode,
          language: room.language,
          script: room.script,
          country: room.country,
          category: room.category,
          entryPoints: room.entryPoints,
          targetPoints: room.targetPoints,
          voiceEnabled: room.voiceEnabled,
          isPublic: room.isPublic,
          maxPlayers: room.maxPlayers
        });

        console.log(`⚙️  Room ${room.id} settings updated`);
      } catch (e) {
        console.error('Update settings error:', e);
        socket.emit('error', { message: 'update_settings_failed' });
      }
    });

    // SELECT TEAM
    socket.on('select_team', async ({ roomId, team }) => {
      try {
        if (!team || (team !== 'orange' && team !== 'blue')) {
          return socket.emit('error', { message: 'invalid_team' });
        }

        const room = await Room.findByPk(roomId);
        if (!room) return socket.emit('error', { message: 'room_not_found' });

        if (room.status !== 'lobby') {
          return socket.emit('error', { message: 'cannot_change_team_after_game_started' });
        }

        if (room.gameMode !== 'team_vs_team') {
          return socket.emit('error', { message: 'not_team_mode' });
        }

        const participant = await RoomParticipant.findOne({
          where: { roomId: room.id, userId: socket.user.id }
        });

        if (!participant) {
          return socket.emit('error', { message: 'not_in_room' });
        }

        participant.team = team;
        await participant.save();

        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar'] }]
        });

        io.to(room.code).emit('room_participants', {
          participants: participants.map(p => ({
            id: p.userId,
            name: p.user ? p.user.name : 'Guest',
            avatar: p.user ? p.user.avatar : null,
            score: p.score,
            team: p.team,
            isDrawer: p.isDrawer
          }))
        });

        console.log(`👥 User ${socket.user.name} selected team ${team}`);
      } catch (e) {
        console.error('Select team error:', e);
        socket.emit('error', { message: 'select_team_failed' });
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

        if (room.ownerId !== socket.user?.id) {
          return socket.emit('error', { message: 'only_owner_can_start' });
        }

        if (room.status !== 'lobby') {
          return socket.emit('error', { message: 'game_already_started' });
        }

        const participants = await RoomParticipant.findAll({
          where: { roomId: room.id, isActive: true },
          include: [{ model: User, as: 'user' }]
        });

        if (participants.length < 2) {
          return socket.emit('error', { message: 'not_enough_players' });
        }

        // For team mode, check both teams have players
        if (room.gameMode === 'team_vs_team') {
          const orangeCount = participants.filter(p => p.team === 'orange').length;
          const blueCount = participants.filter(p => p.team === 'blue').length;
          
          if (orangeCount === 0 || blueCount === 0) {
            return socket.emit('error', { message: 'both_teams_need_players' });
          }
        }

        const entryCost = calculateEntryCost(room.entryPoints, room.voiceEnabled);

        // Deduct entry coins
        for (const participant of participants) {
          const user = await User.findByPk(participant.userId);
          if (!user) continue;

          if (user.coins < entryCost) {
            return socket.emit('error', { 
              message: 'insufficient_coins',
              details: `${user.name} needs ${entryCost} coins to play`
            });
          }

          user.coins -= entryCost;
          await user.save();

          await CoinTransaction.create({
            userId: user.id,
            amount: -entryCost,
            reason: 'game_entry'
          });

          participant.hasPaidEntry = true;
          await participant.save();

          console.log(`💰 Deducted ${entryCost} coins from ${user.name}`);
        }

        room.status = 'playing';
        room.currentRound = 1;
        await room.save();

        io.to(room.code).emit('game_started', { 
          room: { 
            status: room.status,
            entryCost: entryCost
          } 
        });

        console.log(`🎮 Game started in room ${room.code}`);

        await startNewRound(io, room);
      } catch (e) {
        console.error('Start game error:', e);
        socket.emit('error', { message: 'start_game_failed', details: e.message });
      }
    });

    // CHOOSE WORD
    socket.on('choose_word', async ({ roomId, word }) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room) return;

        if (room.currentDrawerId !== socket.user?.id) {
          return socket.emit('error', { message: 'not_your_turn' });
        }

        if (room.roundPhase !== 'choosing_word') {
          return socket.emit('error', { message: 'wrong_phase' });
        }

        if (!room.currentWordOptions || !room.currentWordOptions.includes(word)) {
          return socket.emit('error', { message: 'invalid_word_choice' });
        }

        room.currentWord = word;
        room.currentWordOptions = null;
        await room.save();

        console.log(`📝 Drawer chose word: ${word}`);

        await startDrawingPhase(io, room);
      } catch (e) {
        console.error('Choose word error:', e);
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
        if (room && room.roundPhase === 'drawing') {
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
        let room;
        if (roomCode) {
          room = await Room.findOne({ where: { code: roomCode } });
        } else if (roomId) {
          room = await Room.findByPk(roomId);
        }
        
        if (!room) {
          return socket.emit('guess_result', { ok: false, message: 'room_not_found' });
        }

        if (room.roundPhase !== 'drawing') {
          return socket.emit('guess_result', { ok: false, message: 'not_drawing_phase' });
        }
        
        if (!room.currentWord) {
          return socket.emit('guess_result', { ok: false, message: 'no_active_word' });
        }

        if (!socket.user || !socket.user.id) {
          return socket.emit('guess_result', { ok: false, message: 'not_authenticated' });
        }

        const participant = await RoomParticipant.findOne({
          where: { roomId: room.id, userId: socket.user.id }
        });
        
        if (!participant) {
          return socket.emit('guess_result', { ok: false, message: 'not_in_room' });
        }
        
        if (participant.isDrawer) {
          return socket.emit('guess_result', { ok: false, message: 'drawer_cannot_guess' });
        }

        if (participant.hasGuessedThisRound) {
          return socket.emit('guess_result', { ok: false, message: 'already_guessed' });
        }

        // For team mode, only same team can guess
        if (room.gameMode === 'team_vs_team') {
          const drawer = await RoomParticipant.findOne({
            where: { roomId: room.id, userId: room.currentDrawerId }
          });
          
          if (!drawer || participant.team !== drawer.team) {
            return socket.emit('guess_result', { ok: false, message: 'wrong_team' });
          }
        }

        const normalized = (guess || '').toString().trim().toLowerCase();
        const word = room.currentWord.toString().trim().toLowerCase();
        const isCorrect = normalized === word;

        if (isCorrect) {
          const reward = calculateGuessReward(room.roundRemainingTime, room.maxPointsPerRound);
          
          // Award points
          if (room.gameMode === 'team_vs_team') {
            // Award to entire team
            const teamParticipants = await RoomParticipant.findAll({
              where: { roomId: room.id, team: participant.team, isActive: true }
            });
            
            for (const teamMember of teamParticipants) {
              teamMember.score += reward;
              await teamMember.save();
            }
          } else {
            participant.score += reward;
            await participant.save();
          }

          participant.hasGuessedThisRound = true;
          await participant.save();

          // Reduce time
          const activePlayers = await RoomParticipant.count({
            where: { roomId: room.id, isActive: true, isDrawer: false }
          });
          
          if (activePlayers > 0) {
            const timeReduction = calculateTimeReduction(room.roundRemainingTime, activePlayers);
            room.roundRemainingTime = Math.max(0, room.roundRemainingTime - timeReduction);
            await room.save();
          }

          io.to(room.code).emit('correct_guess', {
            by: { id: socket.user.id, name: socket.user.name },
            word: room.currentWord,
            points: reward,
            participant: {
              id: participant.userId,
              name: socket.user.name,
              score: participant.score,
              team: participant.team
            },
            remainingTime: room.roundRemainingTime
          });

          // Check if all eligible players guessed
          const eligibleCount = room.gameMode === 'team_vs_team' 
            ? await RoomParticipant.count({
                where: { 
                  roomId: room.id, 
                  isActive: true, 
                  isDrawer: false,
                  team: participant.team 
                }
              })
            : await RoomParticipant.count({
                where: { roomId: room.id, isActive: true, isDrawer: false }
              });

          const guessedCount = await RoomParticipant.count({
            where: { 
              roomId: room.id, 
              isActive: true, 
              hasGuessedThisRound: true 
            }
          });

          if (guessedCount >= eligibleCount) {
            // Everyone guessed, end round early
            const { endDrawingPhase } = require('./roundPhases');
            clearRoomTimer(`${room.code}_drawing`);
            await endDrawingPhase(io, room);
          }
        } else {
          socket.emit('guess_result', { ok: false, message: 'incorrect' });
        }
      } catch (e) {
        console.error('Submit guess error:', e);
      }
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

            const roomClosed = await checkAndCloseEmptyRoom(io, room.id);
            
            if (!roomClosed) {
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
      
      if (socket.user && socket.currentRoom) {
        try {
          const room = await Room.findOne({ where: { code: socket.currentRoom } });
          if (room) {
            await RoomParticipant.update(
              { isActive: false, socketId: null },
              { where: { roomId: room.id, userId: socket.user.id } }
            );

            await checkAndCloseEmptyRoom(io, room.id);
          }
        } catch (e) {
          console.error('Disconnect cleanup error:', e);
        }
      }
    });
  });
};

// Check and close empty room
async function checkAndCloseEmptyRoom(io, roomId) {
  try {
    const activeParticipants = await RoomParticipant.count({
      where: { roomId: roomId, isActive: true }
    });

    if (activeParticipants === 0) {
      await Room.update(
        { status: 'finished' },
        { where: { id: roomId } }
      );
      
      const room = await Room.findByPk(roomId);
      if (room) {
        clearRoomTimer(room.code);
        io.to(room.code).emit('room_closed', { 
          message: 'Room closed - no active participants' 
        });
        console.log(`🏠 Room ${roomId} (${room.name}) closed`);
      }
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking empty room:', error);
    return false;
  }
}
