module.exports = (sequelize, DataTypes) => {
  const Room = sequelize.define('Room', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING },
    name: { type: DataTypes.STRING, allowNull: true },
    ownerId: { type: DataTypes.BIGINT.UNSIGNED },
    
    // Game mode: '1v1' (multiplayer free-for-all) or 'team_vs_team'
    gameMode: { type: DataTypes.STRING, defaultValue: '1v1' }, // '1v1' or 'team_vs_team'
    
    // Lobby settings (configurable before game starts)
    language: { type: DataTypes.STRING, allowNull: true }, // EN, TE, HI
    script: { type: DataTypes.STRING, allowNull: true }, // All, Native, Roman
    country: { type: DataTypes.STRING, allowNull: true }, // All, India, USA, etc
   // category: { type: DataTypes.STRING, allowNull: true }, // Fruits, Animals, Food, Movies (theme)
    category: { 
      type: DataTypes.JSON, 
      defaultValue: [],
      get() {
        const value = this.getDataValue('category');
        // If it's a string (old data), try to parse it or wrap it
        if (typeof value === 'string') {
           return value.includes(',') ? value.split(',') : [value];
        }
        return Array.isArray(value) ? value : [];
      },
      set(val) {
        // Ensure we always save an array
        this.setDataValue('category', Array.isArray(val) ? val : []);
      }
    },

    // Entry and rewards system
    entryPoints: { type: DataTypes.INTEGER, defaultValue: 250 }, // 100, 250, 500
    targetPoints: { type: DataTypes.INTEGER, defaultValue: 100 }, // Points needed to win
    maxPointsPerRound: { type: DataTypes.INTEGER, defaultValue: 20 }, // Max points drawer can earn per round (min(guessedCount*2, this))
    
    maxPlayers: { type: DataTypes.INTEGER, defaultValue: 5 }, // Default 5, can be incremented up to 15 in lobby
    voiceEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    isPublic: { type: DataTypes.BOOLEAN, defaultValue: false }, // Default private
    
    // Game state
    status: { type: DataTypes.STRING, defaultValue: 'lobby' }, // lobby, playing, finished
    currentWord: { type: DataTypes.STRING, allowNull: true },
    usedWords: {
      type: DataTypes.JSON, // Stores array like ["apple", "banana"]
      defaultValue: [],     // Starts empty
      get() {
        // Safety check to ensure we always get an array
        const value = this.getDataValue('usedWords');
        return Array.isArray(value) ? value : [];
      },
      set(val) {
        this.setDataValue('usedWords', Array.isArray(val) ? val : []);
      },
    },
    currentWordOptions: { type: DataTypes.JSON, allowNull: true }, // 3 word choices for drawer
    currentDrawerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    currentRound: { type: DataTypes.INTEGER, defaultValue: 0 },
    roundStartTime: { type: DataTypes.DATE, allowNull: true },
    roundPhase: { type: DataTypes.STRING, allowNull: true }, // 'selecting_drawer', 'choosing_word', 'drawing', 'reveal', 'interval'
    roundPhaseEndTime: { type: DataTypes.DATE, allowNull: true },
    roundRemainingTime: { type: DataTypes.INTEGER, defaultValue: 80 }, // Drawing time in seconds
    drawerPointerIndex: {
  type: DataTypes.INTEGER,
  defaultValue: 0,
},
    // Theme reference
    themeId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    
    // Track who has drawn (for fair rotation)
    drawnUserIds: {
      type: DataTypes.JSON,
      defaultValue: [],
      // FIX: The getter ensures that if the database returns null or {}, 
      // JavaScript receives a safe empty array instead.
      get() {
        const value = this.getDataValue('drawnUserIds');
        return Array.isArray(value) ? value : [];
      },
      // The setter is optional but good practice to ensure only arrays are saved.
      set(val) {
        this.setDataValue('drawnUserIds', Array.isArray(val) ? val : []);
      },
    }
  }, {
    tableName: 'rooms',
    indexes: [
      { unique: true, fields: ['code'] }
    ]
  });

  Room.beforeDestroy(async (room, options) => {
    const { Report, Message, RoomParticipant } = room.sequelize.models;
    const transaction = options.transaction || null;
    const opts = transaction ? { transaction } : {};
    await Report.destroy({ where: { roomId: room.id }, ...opts });
    await Message.destroy({ where: { roomId: room.id }, ...opts });
    await RoomParticipant.destroy({ where: { roomId: room.id }, ...opts });
  });

  return Room;
};
