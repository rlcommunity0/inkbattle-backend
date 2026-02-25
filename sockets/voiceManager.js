const mediasoup = require('mediasoup');

let workers = [];
const rooms = new Map(); // Map<roomId, { router, sockets: Set<socketId> }>
const transports = new Map(); // Map<socketId, transport>
const producers = new Map(); // Map<socketId, producer>
const consumers = new Map(); // Map<socketId, Set<consumer>>

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
];

async function createWorker() {
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds...');
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

const voiceManager = {
  async init() {
    const numWorkers = 1;
    for (let i = 0; i < numWorkers; i++) {
      workers.push(await createWorker());
    }
  },
async connectTransport(socketId, dtlsParameters) {
  const transport = this.getTransport(socketId);
  if (!transport) {
    console.warn(`❌ No transport found for socket ${socketId}`);
    return null;
  }

  // Prevent reconnecting an already-connected transport
  if (transport._connected) {
    console.log(`⚠️ Transport for socket ${socketId} already connected`);
    return transport;
  }

  try {
    await transport.connect({ dtlsParameters });
    transport._connected = true;
    console.log(`✅ Mediasoup transport connected for socket ${socketId}`);
    return transport;
  } catch (err) {
    console.error(`❌ Failed to connect transport for socket ${socketId}:`, err);
    return null;
  }
},

  async join(socketId, roomId) {
  if (!rooms.has(roomId)) {
    const worker = workers[Math.floor(Math.random() * workers.length)];
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(roomId, { router, sockets: new Set([socketId]) });

    console.log(
      `✅ Room ${roomId} created and socket ${socketId} joined. Total rooms: ${rooms.size}`
    );
  } else {
    rooms.get(roomId).sockets.add(socketId);
    console.log(`➡️ Socket ${socketId} joined existing room ${roomId}`);
  }
 
  return rooms.get(roomId).router;
},
_buildConsumerAnswerSdp({ router, consumer, offer }) {
  const sdpTransform = require('sdp-transform');
  const answer = {
    version: 0,
    origin: {
      username: '-',
      sessionId: Date.now(),
      sessionVersion: 2,
      netType: 'IN',
      addrType: 'IP4',
      unicastAddress: '127.0.0.1'
    },
    name: '-',
    timing: { start: 0, stop: 0 },
    groups: [{ type: 'BUNDLE', mids: '0' }],
    media: []
  };

  const codec = consumer.rtpParameters.codecs[0];
  const m = {
    type: 'audio',
    port: 9,
    protocol: 'UDP/TLS/RTP/SAVPF',
    payloads: codec.payloadType.toString(),
    connection: { version: 4, ip: '0.0.0.0' },
    direction: 'sendonly',
    rtp: [
      {
        payload: codec.payloadType,
        codec: codec.mimeType.split('/')[1],
        rate: codec.clockRate,
        encoding: codec.channels > 1 ? codec.channels : undefined
      }
    ],
    fmtp: codec.parameters
      ? [{ payload: codec.payloadType, config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(';') }]
      : [],
    rtcpFb: codec.rtcpFeedback?.map(fb => ({
      payload: codec.payloadType,
      type: fb.type,
      subtype: fb.parameter || undefined
    })) || [],
    candidates: [],
    iceUfrag: offer.media[0].iceUfrag || 'ufrag',
    icePwd: offer.media[0].icePwd,
    fingerprint: offer.media[0].fingerprint,
    setup: 'passive',
    mid: '0',
    ssrcs: [
      {
        id: consumer.rtpParameters.encodings[0].ssrc,
        attribute: 'cname',
        value: consumer.rtpParameters.rtcp.cname,
      }
    ]
  };

  // ✅ ADD THESE TWO LINES ↓↓↓
  m.rtcpMux = 'rtcp-mux';
  m.rtcpRsize = 'rtcp-rsize';

  m.rtcpMux = 'rtcp-mux';
  m.rtcpRsize = 'rtcp-rsize';

  answer.media.push(m);
  return sdpTransform.write(answer);
},
getConsumerByProducerId(socketId, producerId) {
    if (consumers.has(socketId)) {
      for (const consumer of consumers.get(socketId)) {
        if (consumer.producerId === producerId) {
          return consumer;
        }
      }
    }
    return null;
  },

  getConsumer(socketId, consumerId) {
    if (consumers.has(socketId)) {
      for (const consumer of consumers.get(socketId)) {
        if (consumer.id === consumerId) {
          return consumer;
        }
      }
    }
    return null;
  }


,

  getRouter(roomId) {
    return rooms.has(roomId) ? rooms.get(roomId).router : null;
  },

  getRoom(socket) {
  const roomId = socket.data?.roomId || socket.roomId;
  if (!roomId) return null;
  return rooms.get(roomId);
},
getProducerBySocketId(socketId) {
  return producers.get(socketId) || null;
},


  
  async createTransport(router) {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '192.168.1.2' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  },

  addTransport(socketId, transport) {
    transports.set(socketId, transport);
  },

  getTransport(socketId) {
    return transports.get(socketId);
  },

  addProducer(socketId, producer) {
    producers.set(socketId, producer);
    return producer.id;
  },

  getProducer(producerId) {
    for (const producer of producers.values()) {
      if (producer.id === producerId) {
        return producer;
      }
    }
    return null;
  },
  
  getProducers(roomId, excludeSocketId) {
    const producerList = [];
    if (rooms.has(roomId)) {
      const roomSockets = rooms.get(roomId).sockets;
      for (const socketId of roomSockets) {
        if (socketId !== excludeSocketId && producers.has(socketId)) {
          const producer = producers.get(socketId);
          producerList.push({ producerId: producer.id, userId: producer.appData.userId });
        }
      }
    }
    return producerList;
  },

  addConsumer(socketId, consumer) {
    if (!consumers.has(socketId)) {
      consumers.set(socketId, new Set());
    }
    consumers.get(socketId).add(consumer);
  },

  getConsumer(socketId, consumerId) {
    if (consumers.has(socketId)) {
      for (const consumer of consumers.get(socketId)) {
        if (consumer.id === consumerId) {
          return consumer;
        }
      }
    }
    return null;
  },

  getOtherSocketIds(socketId, roomId) {
    if (rooms.has(roomId)) {
      return [...rooms.get(roomId).sockets].filter(id => id !== socketId);
    }
    return [];
  },

  handleDisconnect(socketId) {
    let roomId = null;
    let userId = null;
    let producerId = null;

    // Find room
    for (const [key, room] of rooms.entries()) {
      if (room.sockets.has(socketId)) {
        roomId = key;
        room.sockets.delete(socketId);
        if (room.sockets.size === 0) {
          rooms.delete(key);
        }
        break;
      }
    }

    // Close transport
    const transport = transports.get(socketId);
    if (transport) {
      transport.close();
      transports.delete(socketId);
    }

    // Close producer
    const producer = producers.get(socketId);
    if (producer) {
      userId = producer.appData.userId;
      producerId = producer.id;
      producer.close();
      producers.delete(socketId);
    }

    // Close consumers
    const consumerSet = consumers.get(socketId);
    if (consumerSet) {
      for (const consumer of consumerSet) {
        consumer.close();
      }
      consumers.delete(socketId);
    }
    
    return { roomId, userId, producerId };
  }
};

voiceManager.init();

module.exports = voiceManager;
