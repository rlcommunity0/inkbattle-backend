const express = require("express");
const router = express.Router();
const { User, CoinTransaction, Language } = require("../models");

// Configurable rewards
const DAILY_LOGIN_COINS = 1000;
const AD_REWARD_COINS = 1000;

// Get current user profile (protected by global middleware)
router.get("/me", async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user });
});

// Add coins to user account (protected by global middleware)
router.post("/add-coins", async (req, res) => {
  const { amount, reason } = req.body;
  if (!amount) return res.status(400).json({ error: "amount_required" });
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  user.coins += parseInt(amount, 10);
  await user.save();
  await CoinTransaction.create({
    userId: user.id,
    amount,
    reason: reason || "manual",
  });
  res.json({ user });
});

// Claim daily login bonus (protected by global middleware)
router.post("/claim-daily-bonus", async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    const now = new Date();
    const lastLogin = user.lastLoginDate ? new Date(user.lastLoginDate) : null;

    // Check if 24 hours have passed
    if (lastLogin) {
      const hoursSinceLastLogin = (now - lastLogin) / (1000 * 60 * 60);

      if (hoursSinceLastLogin < 24) {
        const hoursRemaining = Math.ceil(24 - hoursSinceLastLogin);
        return res.status(400).json({
          error: "already_claimed_today",
          message: `Come back in ${hoursRemaining} hours`,
          hoursRemaining,
        });
      }
    }

    // Award daily login bonus
    user.coins += DAILY_LOGIN_COINS;
    user.lastLoginDate = now;

    // Update streak
    if (lastLogin) {
      const daysSinceLastLogin = (now - lastLogin) / (1000 * 60 * 60 * 24);
      if (daysSinceLastLogin <= 1.5) {
        // Allow some grace period
        user.dailyLoginStreak += 1;
      } else {
        user.dailyLoginStreak = 1; // Reset streak
      }
    } else {
      user.dailyLoginStreak = 1;
    }

    await user.save();
    await CoinTransaction.create({
      userId: user.id,
      amount: DAILY_LOGIN_COINS,
      reason: "daily_login_bonus",
    });

    console.log(
      `💰 User ${user.name} claimed daily bonus: ${DAILY_LOGIN_COINS} coins (Streak: ${user.dailyLoginStreak})`,
    );

    res.json({
      success: true,
      coinsAwarded: DAILY_LOGIN_COINS,
      totalCoins: user.coins,
      streak: user.dailyLoginStreak,
      user,
    });
  } catch (err) {
    console.error("Daily bonus error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// Check if daily bonus is available (protected by global middleware)
router.get("/daily-bonus-status", async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    const now = new Date();
    const lastLogin = user.lastLoginDate ? new Date(user.lastLoginDate) : null;

    let canClaim = true;
    let hoursRemaining = 0;

    if (lastLogin) {
      const hoursSinceLastLogin = (now - lastLogin) / (1000 * 60 * 60);
      if (hoursSinceLastLogin < 24) {
        canClaim = false;
        hoursRemaining = Math.ceil(24 - hoursSinceLastLogin);
      }
    }

    res.json({
      canClaim,
      hoursRemaining,
      rewardAmount: DAILY_LOGIN_COINS,
      streak: user.dailyLoginStreak || 0,
      lastClaimDate: user.lastLoginDate,
    });
  } catch (err) {
    console.error("Daily bonus status error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// Claim ad reward (protected by global middleware)
router.post("/claim-ad-reward", async (req, res) => {
  try {
    const { adType } = req.body; // 'banner' or 'interstitial'

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "not_found" });

    // Award ad coins
    user.coins += AD_REWARD_COINS;
    await user.save();

    await CoinTransaction.create({
      userId: user.id,
      amount: AD_REWARD_COINS,
      reason: `ad_reward_${adType || "unknown"}`,
    });

    console.log(
      `📺 User ${user.name} watched ad and earned ${AD_REWARD_COINS} coins`,
    );

    res.json({
      success: true,
      coinsAwarded: AD_REWARD_COINS,
      totalCoins: user.coins,
      user,
    });
  } catch (err) {
    console.error("Ad reward error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// Get all supported languages (protected by global middleware)
router.get("/languages", async (req, res) => {
  try {
    console.log("📋 GET /users/languages request");

    const languages = await Language.findAll({
      attributes: ["id", "languageName", "languageCode"],
      order: [["languageName", "ASC"]],
    });

    const languagesList = languages.map((lang) => ({
      id: lang.id,
      languageName: lang.languageName,
      languageCode: lang.languageCode,
    }));

    console.log(`   ✅ Returning ${languagesList.length} languages`);
    return res.json({ languages: languagesList });
  } catch (err) {
    console.error("Languages error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

module.exports = router;
