const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../utils/auth");
const wordRoutes = require("./words");

const authRoutes = require("./auth");
const userRoutes = require("./users");
const roomRoutes = require("./rooms");
const themeRoutes = require("./themes");
const reportRoutes = require("./reports");
const agoraRoutes = require("./agora");

// Auth routes don't need authentication middleware
router.use("/auth", authRoutes);

// Protected routes - require authentication
router.use("/users", authMiddleware, userRoutes);
router.use("/rooms", authMiddleware, roomRoutes);
router.use("/themes", authMiddleware, themeRoutes);
router.use("/report", authMiddleware, reportRoutes);
router.use("/agora", authMiddleware, agoraRoutes);

router.use("/words", wordRoutes);

module.exports = router;
