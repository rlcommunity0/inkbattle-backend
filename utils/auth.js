const jwt = require("jsonwebtoken");
require("dotenv").config();
const secret = process.env.JWT_SECRET || "change_this_secret";
const { Token, User } = require("../models");

function sign(userId) {
  return jwt.sign({ id: userId }, secret, { expiresIn: "30d" });
}

function verify(token) {
  try {
    console.log(jwt.verify(token, secret));
    return jwt.verify(token, secret);
  } catch (e) {
    return null;
  }
}

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h)
    return res.status(401).json({ error: "Missing Authorization header" });

  const parts = h.split(" ");
  if (parts.length !== 2)
    return res.status(401).json({ error: "Invalid Authorization header" });

  const tokenString = parts[1];
  const payload = verify(tokenString);
  if (!payload) return res.status(401).json({ error: "Invalid token" });

  // Validate token exists in database and is not deleted/expired
  const dbToken = await Token.findOne({
    where: {
      token: tokenString,
      userId: payload.id,
      isDeleted: false,
    },
  });

  if (!dbToken) {
    return res.status(401).json({ error: "Token not found or revoked" });
  }

  // Check if token is expired
  if (new Date() > new Date(dbToken.expiresAt)) {
    return res.status(401).json({ error: "Token expired" });
  }
  let user = await User.findByPk(payload.id);
  req.user = user;
  req.token = tokenString;
  next();
}

module.exports = { sign, verify, authMiddleware };
