module.exports = (sequelize, DataTypes) => {
  const Token = sequelize.define('Token', {
    id: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      primaryKey: true, 
      autoIncrement: true 
    },
    userId: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    token: { 
      type: DataTypes.STRING(255), 
      allowNull: false,
      unique: true 
    },
    expiresAt: { 
      type: DataTypes.DATE, 
      allowNull: false 
    },
    isDeleted: { 
      type: DataTypes.BOOLEAN, 
      defaultValue: false 
    }
  }, { 
    tableName: 'tokens',
    indexes: [
      { fields: ['userId'] },
      { fields: ['expiresAt'] }
    ]
  });

  return Token;
};
