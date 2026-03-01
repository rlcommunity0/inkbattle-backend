/**
 * Deletes expired guest users (TTL cleanup). Removes: guestExpiresAt < now, and legacy rows (guestExpiresAt IS NULL).
 *
 * DB setup (if you do NOT use sequelize.sync):
 *   MySQL:   ALTER TABLE users ADD COLUMN guestExpiresAt DATETIME NULL;
 *   Add index for fast cleanup: CREATE INDEX idx_guest_expires ON users(provider, guestExpiresAt);
 *
 * Cron (daily, e.g. 3 AM):
 *   0 3 * * * cd /path/to/backend_archive && node scripts/cleanupExpiredGuests.js
 *
 * Dry run (no delete): CLEANUP_GUESTS_DRY_RUN=1 node scripts/cleanupExpiredGuests.js
 */

require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const { User, Token, RoomParticipant, CoinTransaction, Message, Room, sequelize } = require("../models");
const { Op } = require("sequelize");

const DRY_RUN = process.env.CLEANUP_GUESTS_DRY_RUN === "1";

(async () => {
  try {
    console.log("🧹 Starting expired guest cleanup...");
    console.log(`🧪 DRY_RUN = ${DRY_RUN}`);

    // Delete guests that are expired (guestExpiresAt < now) or legacy rows (guestExpiresAt IS NULL)
    const expiredGuests = await User.findAll({
      where: {
        provider: "guest",
        [Op.or]: [
          { guestExpiresAt: { [Op.lt]: new Date() } },
          { guestExpiresAt: { [Op.is]: null } },
        ],
      },
      attributes: ["id"],
    });

    const ids = expiredGuests.map((u) => u.id);
    if (ids.length === 0) {
      console.log("✅ No expired guest accounts to delete.");
      process.exit(0);
      return;
    }

    console.log(`🔍 Found ${ids.length} expired guest user(s) to delete.`);

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN: would delete user ids:", ids);
      process.exit(0);
      return;
    }

    await sequelize.transaction(async (t) => {
      await Token.destroy({ where: { userId: { [Op.in]: ids } }, transaction: t });
      await RoomParticipant.destroy({ where: { userId: { [Op.in]: ids } }, transaction: t });
      await Message.destroy({ where: { userId: { [Op.in]: ids } }, transaction: t });
      await CoinTransaction.destroy({ where: { userId: { [Op.in]: ids } }, transaction: t });
      await Room.update({ ownerId: null }, { where: { ownerId: { [Op.in]: ids } }, transaction: t });
      await User.destroy({ where: { id: { [Op.in]: ids } }, transaction: t });
    });

    console.log(`✅ Deleted ${ids.length} expired guest account(s).`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  }
})();
