const express = require("express");
const router = express.Router();
const { User, CoinTransaction, Token } = require("../models");
const { sign, authMiddleware } = require("../utils/auth");
const { normalizeCountryCode } = require("../utils/countryCode");

const coinsForRegisteredUsers = 1000;
const coinsForGuestUsers = 1000;

// Simple provider-based signup/login.
// Frontend should send: { provider: 'google'|'facebook', providerId: '...', name, email, avatar }
router.post("/signup", async (req, res) => {
  const { provider, providerId, name, avatar, language, country } = req.body;
  if (!provider || !providerId)
    return res.status(400).json({ error: "provider & providerId required" });
  try {
    // Guest: providerId is required (stable client-generated id for find-or-create). Non-guest: provider+providerId.
    const effectiveProviderId = provider === "guest" ? (providerId || `guest_${Date.now()}`) : providerId;
    let user = await User.findOne({ where: { provider, providerId: effectiveProviderId } });
    let isNew = false;
    if (!user) {
      if (provider === "guest") {
        // Normalize country to ISO-2 code (supports backward compatibility)
        const normalizedCountry = country ? normalizeCountryCode(country) : null;
        const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        user = await User.create({
          provider,
          providerId: effectiveProviderId,
          name,
          avatar,
          coins: coinsForGuestUsers,
          language,
          country: normalizedCountry,
          guestExpiresAt: oneDayFromNow,
        });
        isNew = true;
        await CoinTransaction.create({
          userId: user.id,
          amount: coinsForGuestUsers,
          reason: "signup_bonus",
        });
      } else {
        // Normalize country to ISO-2 code (supports backward compatibility)
        const normalizedCountry = country ? normalizeCountryCode(country) : null;
        user = await User.create({
          provider,
          providerId,
          name,
          avatar,
          coins: coinsForRegisteredUsers,
          language,
          country: normalizedCountry,
        });
        isNew = true;
        await CoinTransaction.create({
          userId: user.id,
          amount: coinsForRegisteredUsers,
          reason: "signup_bonus",
        });
      }
    }

    const token = sign(user.id);
    await Token.create({
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    res.json({ userId: user.id, token, isNew });
  } catch (err) {
    if (err.name === "SequelizeUniqueConstraintError" && provider === "guest" && effectiveProviderId) {
      const existingUser = await User.findOne({ where: { provider, providerId: effectiveProviderId } });
      if (existingUser) {
        const token = sign(existingUser.id);
        await Token.create({
          userId: existingUser.id,
          token,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        return res.json({ userId: existingUser.id, token, isNew: false });
      }
    }
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// LOGOUT - Revoke current token
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    const tokenString = req.token;

    // Mark token as deleted
    await Token.update(
      { isDeleted: true },
      { where: { token: tokenString, userId: req.user.id } },
    );

    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

router.post("/updateProfile", authMiddleware, async (req, res) => {
  const { name, avatar, language, country } = req.body;
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    user.name = name || user.name;
    user.avatar = avatar || user.avatar;
    user.language = language || user.language;
//    user.country = country || user.country;
    // Normalize country to ISO-2 code (supports backward compatibility)
    if (country !== undefined) {
      user.country = country ? normalizeCountryCode(country) : null;
    }
    await user.save();
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
