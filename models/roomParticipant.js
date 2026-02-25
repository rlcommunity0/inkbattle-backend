module.exports = (sequelize, DataTypes) => {
  const RoomParticipant = sequelize.define('RoomParticipant', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    roomId: { type: DataTypes.BIGINT.UNSIGNED },
    userId: { type: DataTypes.BIGINT.UNSIGNED },
    
    // Team assignment for team_vs_team mode ('orange' or 'blue')
    team: { type: DataTypes.STRING, allowNull: true }, // 'orange' or 'blue'
    
    isDrawer: { type: DataTypes.BOOLEAN, defaultValue: false },
    score: { type: DataTypes.INTEGER, defaultValue: 0 }, // Points in current game

    points_updated_at: { 
      type: DataTypes.DATE, 
      allowNull: true,
      defaultValue: DataTypes.NOW,
      field: 'points_updated_at' // Explicit column name mapping for MySQL
    }, // High-precision timestamp for tie-breaking (earlier timestamp = higher rank)

    // Track if player has drawn in current game
    hasDrawn: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    // Track if player has guessed correctly in current round
    hasGuessedThisRound: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    // Track entry payment
    hasPaidEntry: { type: DataTypes.BOOLEAN, defaultValue: false },
    
    //  If I continuously misses my chance,player has to be eliminated  after he miss his 3 chances
    eliminationCount: { 
      type: DataTypes.INTEGER, 
      defaultValue: 3,
      field: 'elimination_count' // Explicit column name mapping for MySQL
    },

    // Player status
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    socketId: { type: DataTypes.STRING, allowNull: true },
    skipCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    // When set, user cannot re-join this room (banned)
    bannedAt: { type: DataTypes.DATE, allowNull: true }
  }, { tableName: 'room_participants' });

  return RoomParticipant;
};
