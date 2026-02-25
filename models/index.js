const sequelize = require("../config/database");
const { DataTypes } = require("sequelize");

const User = require("./user")(sequelize, DataTypes);
const Room = require("./room")(sequelize, DataTypes);
const RoomParticipant = require("./roomParticipant")(sequelize, DataTypes);
const Theme = require("./theme")(sequelize, DataTypes);
const Word = require("./word")(sequelize, DataTypes); // Obsolete/Outdated model
const Message = require("./message")(sequelize, DataTypes);
const CoinTransaction = require("./coinTransaction")(sequelize, DataTypes);
const Token = require("./token")(sequelize, DataTypes);
const Report = require("./report")(sequelize, DataTypes);
const Language = require("./language")(sequelize, DataTypes);
const Keyword = require("./keyword")(sequelize, DataTypes);
const Translation = require("./translation")(sequelize, DataTypes);

// ===================================
// ASSOCIATIONS
// ===================================

// User-Room One-to-Many
User.hasMany(Room, { foreignKey: "ownerId" });
Room.belongsTo(User, { foreignKey: "ownerId", as: "owner" });

// Room-User Many-to-Many through RoomParticipant
Room.belongsToMany(User, {
  through: RoomParticipant,
  foreignKey: "roomId",
  otherKey: "userId",
});
User.belongsToMany(Room, {
  through: RoomParticipant,
  foreignKey: "userId",
  otherKey: "roomId",
});

// Direct associations for RoomParticipant
Room.hasMany(RoomParticipant, { foreignKey: "roomId", as: "participants" });
RoomParticipant.belongsTo(Room, { foreignKey: "roomId" });
RoomParticipant.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(RoomParticipant, { foreignKey: "userId" });

// --- OBSELETE WORD MODEL ASSOCIATIONS (COMMENTED OUT) ---
// Theme.hasMany(Word, { foreignKey: 'themeId' });
// Word.belongsTo(Theme, { foreignKey: 'themeId' });

// Room-Theme One-to-Many
Theme.hasMany(Room, { foreignKey: "themeId" });
Room.belongsTo(Theme, { foreignKey: "themeId", as: "theme" });

// Room-Message / User-Message
Room.hasMany(Message, { foreignKey: "roomId" });
Message.belongsTo(Room, { foreignKey: "roomId" });
User.hasMany(Message, { foreignKey: "userId" });
Message.belongsTo(User, { foreignKey: "userId" });

// User-CoinTransaction
User.hasMany(CoinTransaction, { foreignKey: "userId" });
CoinTransaction.belongsTo(User, { foreignKey: "userId" });

// ===================================
// KEYWORD/TRANSLATION STRUCTURE (Core Fix Area)
// ===================================

// FIX 1: Theme -> Keyword Direct One-to-Many (Required if Keyword has themeId column)
// This is necessary for querying keywords FOR a theme (as in getWordsForTheme)
Theme.hasMany(Keyword, { foreignKey: "themeId", as: "keywords" });
Keyword.belongsTo(Theme, { foreignKey: "themeId", as: "theme" });

// FIX 2: Keyword-Translation-Language associations (The inner logic)
Keyword.hasMany(Translation, { foreignKey: "keywordId", as: "translations" });
Translation.belongsTo(Keyword, { foreignKey: "keywordId", as: "keyword" });
Language.hasMany(Translation, {
  foreignKey: "languageId",
  as: "translations_by_language",
}); // Changed alias for clarity
Translation.belongsTo(Language, { foreignKey: "languageId", as: "language" });

// FIX 3: Theme-Keyword Many-to-Many Association (Using junction table)
// This allows a keyword to belong to MULTIPLE themes, if desired.
// Ensure this junction table (theme_keywords) is also created in your DB setup.
Theme.belongsToMany(Keyword, {
  through: "theme_keywords",
  foreignKey: "themeId",
  otherKey: "keywordId",
  as: "theme_keywords_m2m", // Renamed alias to avoid conflict with direct association
});
Keyword.belongsToMany(Theme, {
  through: "theme_keywords",
  foreignKey: "keywordId",
  otherKey: "themeId",
  as: "themes_m2m", // Renamed alias
});

module.exports = {
  sequelize,
  User,
  Room,
  RoomParticipant,
  Theme,
  Word, // Still exported, but relationships removed
  Message,
  CoinTransaction,
  Token,
  Report,
  Language,
  Keyword,
  Translation,
};
