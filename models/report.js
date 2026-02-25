module.exports = (sequelize, DataTypes) => {
	const Report = sequelize.define('Report', {
		id: { 
			type: DataTypes.BIGINT.UNSIGNED, 
			primaryKey: true, 
			autoIncrement: true 
		},
		roomId: { 
			type: DataTypes.BIGINT.UNSIGNED, 
			allowNull: false 
		},
		userToBlockId: { 
			type: DataTypes.BIGINT.UNSIGNED, 
			allowNull: false 
		},
		reportedBy: { 
			type: DataTypes.JSON, 
			defaultValue: [],
			allowNull: false 
		},
		reportCount: { 
			type: DataTypes.INTEGER, 
			defaultValue: 0,
			allowNull: false 
		},
		// First time threshold met = abort drawing (strike 1); second time = ban (strike 2). Only used for reportType 'drawing'.
		strikeCount: {
			type: DataTypes.INTEGER,
			defaultValue: 0,
			allowNull: true
		},
		// Matches MySQL enum('user','drawing'). 'user' = exit on first criteria; 'drawing' = 1st strike abort, 2nd exit.
		reportType: {
			type: DataTypes.ENUM('user', 'drawing'),
			defaultValue: 'drawing',
			allowNull: false
		}
	}, { 
		tableName: 'reports',
		indexes: [
			{ unique: true, fields: ['roomId', 'userToBlockId', 'reportType'] },
			{ fields: ['roomId'] },
			{ fields: ['userToBlockId'] }
		]
	});

	return Report;
};


