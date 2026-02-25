# 🎨 InkBattle Backend

Complete Node.js backend for **InkBattle** - A multiplayer real-time drawing and guessing game.

## 🚀 Features

### Authentication
- ✅ Google SSO integration (provider-based auth)
- ✅ JWT token-based authentication
- ✅ 50 coins signup bonus for new users
- ✅ Coin transaction tracking

### Game Modes
- 🎲 **Random Join** - Auto-match players based on preferences
- 👥 **Multiplayer (Friends)** - Create/join private rooms with codes
- ⚔️ **Team vs Team** - 4v4 team battles with auto-balancing

### Room Management
- ✅ Create rooms with custom settings (language, category, points, voice)
- ✅ Join rooms by 5-character code
- ✅ Public/Private room visibility
- ✅ Max 15 players for random/multiplayer, 8 for team mode
- ✅ Room filtering and listing

### Real-time Gameplay
- 🎨 **Drawing broadcast** - Real-time canvas synchronization
- 💬 **Global chat** - Room-wide messaging with persistence
- ✅ **Guess validation** - Instant feedback with coin rewards
- ⏱️ **Round timer** - 90 seconds per round
- 🔄 **Round-robin drawer selection**
- 🎯 **Score tracking** per player/team

### Themes & Words
- 📚 10 pre-seeded themes (Fruits, Animals, Food, Movies, etc.)
- 🇮🇳 Indian Traditional Dances theme included
- 🎲 Random word selection from theme
- ➕ Dynamic theme/word management APIs

### Voice Chat
- 🎤 WebRTC signaling relay for peer-to-peer voice
- 🔊 Room-wide voice communication support

## 📋 Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MySQL with Sequelize ORM
- **Real-time**: Socket.IO
- **Authentication**: JWT (jsonwebtoken)
- **Voice**: WebRTC signaling

## 🛠️ Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- MySQL (v5.7 or higher)
- npm or yarn

### Step 1: Clone and Install

```bash
cd inkbattles-backend
npm install
```

### Step 2: Database Setup

Create MySQL database:
```sql
CREATE DATABASE inkbattles CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### Step 3: Environment Configuration

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your MySQL credentials:
```env
PORT=4000
JWT_SECRET=your_super_secret_jwt_key_here

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=inkbattles
DB_USER=root
DB_PASS=your_mysql_password
```

### Step 4: Database Migration & Seeding

The app will auto-create tables on first run. To seed themes and words:

```bash
npm run seed
```

This will populate:
- 10 themes (Fruits, Animals, Food, Movies, Indian Traditional Dances, Sports, Vehicles, Musical Instruments, Countries, Professions)
- 200+ words across all themes

### Step 5: Start Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

Server will start on `http://localhost:4000`

## 📡 API Endpoints

### Authentication
- `POST /api/auth/signup` - Sign up with Google SSO
- `POST /api/auth/login` - Login with existing account

### User Management
- `GET /api/users/me` - Get current user profile
- `POST /api/users/add-coins` - Add coins (testing/admin)

### Room Management
- `POST /api/rooms/create` - Create multiplayer room
- `POST /api/rooms/create-team` - Create team vs team room
- `POST /api/rooms/random-join` - Random matchmaking
- `POST /api/rooms/join` - Join room by code
- `GET /api/rooms/list` - List public rooms (with filters)
- `GET /api/rooms/:roomId` - Get room details
- `POST /api/rooms/:roomId/leave` - Leave room

### Themes & Words
- `GET /api/themes` - List all themes with words
- `POST /api/themes` - Create new theme
- `POST /api/themes/:themeId/words` - Add word to theme
- `GET /api/themes/:themeId/random` - Get random word

## 🔌 Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join_room` | `{ roomCode }` | Join a room |
| `leave_room` | `{ roomCode }` | Leave a room |
| `start_game` | `{ roomCode }` | Start game (owner only) |
| `drawing_data` | `{ roomCode, strokes }` | Broadcast drawing |
| `clear_canvas` | `{ roomCode }` | Clear canvas |
| `chat_message` | `{ roomCode, content }` | Send chat message |
| `submit_guess` | `{ roomCode, guess }` | Submit word guess |
| `webrtc_offer` | `{ to, data, roomCode }` | WebRTC offer |
| `webrtc_answer` | `{ to, data, roomCode }` | WebRTC answer |
| `webrtc_ice` | `{ to, data, roomCode }` | WebRTC ICE candidate |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room_joined` | `{ room, participants }` | Successfully joined |
| `room_participants` | `{ participants }` | Updated participant list |
| `game_started` | `{ room }` | Game has started |
| `round_started` | `{ round, drawer, word, wordHint, duration }` | New round |
| `drawing_data` | `{ strokes, from }` | Drawing update |
| `canvas_cleared` | `{ by }` | Canvas cleared |
| `chat_message` | `{ id, content, user, createdAt, type }` | New message |
| `correct_guess` | `{ by, word, participant }` | Correct guess |
| `guess_result` | `{ ok, message }` | Guess feedback |
| `round_ended` | `{ reason, word }` | Round ended |
| `error` | `{ message }` | Error occurred |

## 📁 Project Structure

```
inkbattles-backend/
├── config/
│   └── database.js          # Sequelize configuration
├── models/
│   ├── index.js             # Model associations
│   ├── user.js              # User model
│   ├── room.js              # Room model
│   ├── roomParticipant.js   # Room participants
│   ├── theme.js             # Theme model
│   ├── word.js              # Word model
│   ├── message.js           # Chat messages
│   └── coinTransaction.js   # Coin transactions
├── routes/
│   ├── auth.js              # Authentication routes
│   ├── users.js             # User routes
│   ├── rooms.js             # Room management routes
│   └── themes.js            # Theme/word routes
├── sockets/
│   └── socket.js            # Socket.IO event handlers
├── utils/
│   ├── auth.js              # JWT utilities
│   └── seedThemes.js        # Database seeding script
├── server.js                # Application entry point
├── package.json
├── .env.example
├── postman_collection.json  # Complete API collection
└── README.md
```

## 🧪 Testing with Postman

Import `postman_collection.json` into Postman for complete API testing:

1. Open Postman
2. Import → Upload Files → Select `postman_collection.json`
3. Collection includes all endpoints with example payloads
4. Auto-saves JWT token after signup/login

## 🎮 Game Flow

1. **User signs up** → Receives 50 coins
2. **Creates/joins room** → Chooses preferences (category, language, etc.)
3. **Game starts** → Owner initiates
4. **Round begins** → Random drawer selected, word assigned
5. **Drawer draws** → Others guess in chat
6. **Correct guess** → Guesser gets 20 coins, round ends
7. **Round timeout** → 90 seconds, next drawer selected
8. **Game continues** → Until players leave

## 🔐 Security Notes

- Change `JWT_SECRET` in production
- Use strong MySQL password
- Enable CORS restrictions for production
- Consider rate limiting for APIs
- Use HTTPS in production
- Validate all user inputs

## 🐛 Troubleshooting

### Database Connection Issues
```bash
# Check MySQL is running
mysql -u root -p

# Verify database exists
SHOW DATABASES;
```

### Port Already in Use
```bash
# Change PORT in .env file
PORT=5000
```

### Socket.IO Connection Issues
- Ensure CORS is properly configured
- Check firewall settings
- Verify Socket.IO client version compatibility

## 📝 License

This project is proprietary software for InkBattle.

## 👥 Support

For issues or questions, contact the development team.

---

**Built with ❤️ for InkBattle**
