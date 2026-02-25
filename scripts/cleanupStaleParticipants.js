require("dotenv").config({ path: "../.env" });

const { RoomParticipant } = require("../models");
const { Op } = require("sequelize");

const STALE_MINUTES = 30;

(async () => {
  try {
    console.log("🧹 Cleaning stale participants...");

    const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);

    const updated = await RoomParticipant.update(
      { isActive: false, socketId: null },
      {
        where: {
          isActive: true,
          updatedAt: { [Op.lt]: cutoff },
        },
      }
    );

    console.log(`✅ Marked ${updated[0]} stale participants as inactive`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to clean stale participants:", err);
    process.exit(1);
  }
})();

