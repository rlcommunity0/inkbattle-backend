## Flutter integration notes (Realtime & Voice)

Recommended Flutter packages:
- socket_io_client: ^2.0.0 (for Socket.IO realtime)
- flutter_webrtc: ^0.9.0 (for voice via WebRTC)
- http (for REST API)
- jwt_decode (optional to decode token client-side)

Socket handshake:
- Connect with auth token: io(url, { auth: { token: '<JWT>' } })
Events used:
- join_room, leave_room
- drawing_data  -> { roomCode, strokes }
- chat_message  -> { roomCode, content }
- submit_guess  -> { roomCode, guess }
- correct_guess -> emitted by server when someone guesses correctly
- room_participants -> list of participants

WebRTC signaling (for voice):
- Clients exchange offers/answers/ice through server events: webrtc_offer, webrtc_answer, webrtc_ice.
- Server only relays signaling — clients must open peer connections with flutter_webrtc.

Coins:
- Sign up automatically grants +50 coins (persisted)
- Correct guess awards +20 coins to guesser (logged as coin transaction)

Database:
- Sequelize auto-sync is enabled (development only). For production, create proper migrations.

