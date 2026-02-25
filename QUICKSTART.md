# 🚀 InkBattle Backend - Quick Start Guide

## Prerequisites Checklist
- [ ] Node.js installed (v14+)
- [ ] MySQL installed and running
- [ ] Git installed

## 5-Minute Setup

### 1. Install Dependencies
```bash
cd inkbattles-backend
npm install
```

### 2. Create Database
```bash
mysql -u root -p
```
```sql
CREATE DATABASE inkbattles;
EXIT;
```

### 3. Configure Environment
```bash
cp .env.example .env
```

Edit `.env` - **Only change these lines:**
```env
DB_PASS=your_mysql_password
JWT_SECRET=any_random_string_here_make_it_long
```

### 4. Seed Database
```bash
npm run seed
```

Expected output:
```
✅ Created theme: Fruits
✅ Created theme: Animals
...
📊 Summary:
   Total Themes: 10
   Total Words: 200+
```

### 5. Start Server
```bash
npm run dev
```

Expected output:
```
Server running on port 4000
```

## ✅ Verify Installation

### Test 1: Health Check
Open browser: `http://localhost:4000`

Should see: `{"ok":true}`

### Test 2: Get Themes
```bash
curl http://localhost:4000/api/themes
```

Should return JSON with themes and words.

### Test 3: Signup
```bash
curl -X POST http://localhost:4000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google",
    "providerId": "test123",
    "name": "Test User",
    "email": "test@example.com"
  }'
```

Should return:
```json
{
  "user": { "id": 1, "name": "Test User", "coins": 50, ... },
  "token": "eyJhbGc...",
  "isNew": true
}
```

## 🎮 Test with Postman

1. Open Postman
2. Import `postman_collection.json`
3. Run "Signup (Google SSO)" request
4. Token auto-saved - try other requests!

## 📱 Connect Frontend

Update your Flutter app's API base URL:
```dart
const String API_BASE_URL = 'http://localhost:4000';
const String SOCKET_URL = 'http://localhost:4000';
```

For physical device testing:
```dart
const String API_BASE_URL = 'http://YOUR_COMPUTER_IP:4000';
```

Find your IP:
- **Mac/Linux**: `ifconfig | grep inet`
- **Windows**: `ipconfig`

## 🔧 Common Issues

### Port 4000 Already in Use
```bash
# Change port in .env
PORT=5000
```

### MySQL Connection Failed
```bash
# Check MySQL is running
mysql -u root -p

# Check credentials in .env match MySQL
```

### "Cannot find module"
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Database Tables Not Created
```bash
# Restart server - tables auto-create on first run
npm run dev
```

## 📊 Database Schema

Tables created automatically:
- `users` - User accounts
- `rooms` - Game rooms
- `room_participants` - Players in rooms
- `themes` - Word categories
- `words` - Drawing words
- `messages` - Chat history
- `coin_transactions` - Coin history

## 🎯 Next Steps

1. ✅ Backend running
2. ✅ Database seeded
3. ✅ APIs tested
4. 🔄 Connect Flutter frontend
5. 🎮 Start playing!

## 📚 Full Documentation

See `README.md` for:
- Complete API reference
- Socket.IO events
- Game flow details
- Security notes
- Troubleshooting

## 🆘 Need Help?

Check logs for errors:
```bash
# Server logs show in terminal
# Look for error messages in red
```

Common error patterns:
- `ECONNREFUSED` → MySQL not running
- `ER_ACCESS_DENIED` → Wrong MySQL password
- `EADDRINUSE` → Port already in use

---

**Ready to play! 🎨🎮**
