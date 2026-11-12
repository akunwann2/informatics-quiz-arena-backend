
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";

import db, { testDatabaseConnection } from "./config/database.js";
import questionRoutes from "./routes/questionRoutes.js";
import roomRoutes from "./routes/roomRoutes.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const PORT = Number(process.env.PORT || 3000);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// REST API
// ==========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Informatics Quiz Arena Backend aktif!",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Informatics Quiz Arena Backend aktif!",
    status: "online",
  });
});

app.use("/api/questions", questionRoutes);
app.use("/api/categories", questionRoutes);
app.use("/api/rooms", roomRoutes);

// ==========================================
// JSON 404 HANDLER
// Harus diletakkan setelah semua REST routes.
// ==========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan`,
  });
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {
  console.error("Express error:", error);

  res.status(500).json({
    success: false,
    message: "Terjadi kesalahan pada server",
  });
});

// ==========================================
// GAME TIMER
// ==========================================

const gameTimers = new Map();
const activeQuestionEndsAt = new Map();

// ==========================================
// HELPER: ROOM STATE
// ==========================================

async function getRoomState(roomId) {
  const [rooms] = await db.execute(
    `SELECT
      id,
      room_code,
      status,
      max_players,
      question_count,
      time_per_question,
      current_question_index
     FROM game_rooms
     WHERE id = ?
     LIMIT 1`,
    [roomId]
  );

  if (rooms.length === 0) {
    return null;
  }

  const [players] = await db.execute(
    `SELECT
      id AS player_id,
      nickname,
      score,
      is_host,
      is_connected
     FROM room_players
     WHERE room_id = ?
     ORDER BY is_host DESC, joined_at ASC`,
    [roomId]
  );

  return {
    room: rooms[0],
    players,
  };
}

// ==========================================
// HELPER: PUBLISH ROOM STATE
// ==========================================

async function publishRoomState(roomId) {
  const state = await getRoomState(roomId);

  if (state) {
    io.to(`room_${roomId}`).emit("room:updated", state);
  }
}

// ==========================================
// HELPER: PUBLISH CURRENT QUESTION
// ==========================================

async function publishCurrentQuestion(roomId) {
  try {
    const [rooms] = await db.execute(
      `SELECT
        id,
        status,
        question_count,
        time_per_question,
        current_question_index
       FROM game_rooms
       WHERE id = ?
       LIMIT 1`,
      [roomId]
    );

    if (rooms.length === 0 || rooms[0].status !== "playing") {
      return;
    }

    const room = rooms[0];
    const questionOrder = Number(room.current_question_index) + 1;

    const [questions] = await db.execute(
      `SELECT
        rq.id AS room_question_id,
        rq.question_id,
        q.question_text,
        q.difficulty,
        q.explanation
       FROM room_questions rq
       INNER JOIN questions q ON q.id = rq.question_id
       WHERE rq.room_id = ?
         AND rq.question_order = ?
       LIMIT 1`,
      [roomId, questionOrder]
    );

    if (questions.length === 0) {
      await finishGame(roomId);
      return;
    }

    const question = questions[0];

    const [options] = await db.execute(
      `SELECT
        qo.id AS option_id,
        qo.option_text,
        rqo.display_order
       FROM room_question_options rqo
       INNER JOIN question_options qo ON qo.id = rqo.option_id
       WHERE rqo.room_question_id = ?
       ORDER BY rqo.display_order ASC`,
      [question.room_question_id]
    );

    const duration = Number(room.time_per_question);
    const endsAt = Date.now() + duration * 1000;

    activeQuestionEndsAt.set(roomId, endsAt);

    io.to(`room_${roomId}`).emit("game:question_started", {
      question_number: questionOrder,
      total_questions: Number(room.question_count),
      question_id: question.question_id,
      question_text: question.question_text,
      difficulty: question.difficulty,
      options,
      duration,
      ends_at: endsAt,
    });

    console.log(`Room ${roomId}: soal ${questionOrder} dimulai`);

    const oldTimer = gameTimers.get(roomId);

    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer = setTimeout(async () => {
      gameTimers.delete(roomId);
      activeQuestionEndsAt.delete(roomId);

      await advanceGame(roomId);
    }, duration * 1000);

    gameTimers.set(roomId, timer);

  } catch (error) {
    console.error("publishCurrentQuestion error:", error);
  }
}

// ==========================================
// HELPER: ADVANCE GAME
// ==========================================

async function advanceGame(roomId) {
  try {
    const [rooms] = await db.execute(
      `SELECT
        id,
        status,
        question_count,
        current_question_index
       FROM game_rooms
       WHERE id = ?
       LIMIT 1`,
      [roomId]
    );

    if (rooms.length === 0 || rooms[0].status !== "playing") {
      return;
    }

    const room = rooms[0];
    const nextIndex = Number(room.current_question_index) + 1;

    if (nextIndex >= Number(room.question_count)) {
      await finishGame(roomId);
      return;
    }

    await db.execute(
      `UPDATE game_rooms
       SET current_question_index = ?
       WHERE id = ?`,
      [nextIndex, roomId]
    );

    await publishCurrentQuestion(roomId);

  } catch (error) {
    console.error("advanceGame error:", error);
  }
}

// ==========================================
// HELPER: FINISH GAME
// ==========================================

async function finishGame(roomId) {
  try {
    const timer = gameTimers.get(roomId);

    if (timer) {
      clearTimeout(timer);
      gameTimers.delete(roomId);
    }

    activeQuestionEndsAt.delete(roomId);

    await db.execute(
      `UPDATE game_rooms
       SET status = 'finished',
           ended_at = NOW()
       WHERE id = ?`,
      [roomId]
    );

    const [leaderboard] = await db.execute(
      `SELECT
        id AS player_id,
        nickname,
        score,
        is_host
       FROM room_players
       WHERE room_id = ?
       ORDER BY score DESC, joined_at ASC`,
      [roomId]
    );

    io.to(`room_${roomId}`).emit("game:finished", {
      message: "Kuis telah selesai!",
      leaderboard,
    });

    console.log(`Room ${roomId}: kuis selesai`);

  } catch (error) {
    console.error("finishGame error:", error);
  }
}

// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", (socket) => {
  console.log("Socket terhubung:", socket.id);

  // ========================================
  // PLAYER JOIN ROOM
  // ========================================

  socket.on("room:join", async (data) => {
    try {
      const roomCode = String(data?.room_code || "")
        .trim()
        .toUpperCase();

      const playerId = Number(data?.player_id);

      if (!roomCode || !Number.isInteger(playerId) || playerId <= 0) {
        socket.emit("room:error", {
          message: "Data room atau pemain tidak valid",
        });
        return;
      }

      const [rooms] = await db.execute(
        `SELECT id, room_code, status
         FROM game_rooms
         WHERE room_code = ?
         LIMIT 1`,
        [roomCode]
      );

      if (rooms.length === 0) {
        socket.emit("room:error", {
          message: "Room tidak ditemukan",
        });
        return;
      }

      const room = rooms[0];

      if (room.status === "finished") {
        socket.emit("room:error", {
          message: "Kuis sudah selesai",
        });
        return;
      }

      const [players] = await db.execute(
        `SELECT id, nickname, is_host
         FROM room_players
         WHERE id = ? AND room_id = ?
         LIMIT 1`,
        [playerId, room.id]
      );

      if (players.length === 0) {
        socket.emit("room:error", {
          message: "Pemain tidak terdaftar di room ini",
        });
        return;
      }

      const player = players[0];

      socket.data.roomId = room.id;
      socket.data.playerId = playerId;

      await db.execute(
        `UPDATE room_players
         SET socket_id = ?,
             is_connected = 1
         WHERE id = ? AND room_id = ?`,
        [socket.id, playerId, room.id]
      );

      socket.join(`room_${room.id}`);

      const state = await getRoomState(room.id);

      socket.emit("room:joined", {
        success: true,
        room: state.room,
        players: state.players,
        player: {
          player_id: playerId,
          nickname: player.nickname,
          is_host: player.is_host,
        },
      });

      await publishRoomState(room.id);

      // Sinkronisasi soal jika pemain masuk saat kuis berjalan.
      if (room.status === "playing") {
        const [activeRooms] = await db.execute(
          `SELECT
            question_count,
            time_per_question,
            current_question_index
           FROM game_rooms
           WHERE id = ?
           LIMIT 1`,
          [room.id]
        );

        if (activeRooms.length > 0) {
          const activeRoom = activeRooms[0];

          const questionOrder =
            Number(activeRoom.current_question_index) + 1;

          const [questions] = await db.execute(
            `SELECT
              rq.id AS room_question_id,
              rq.question_id,
              q.question_text,
              q.difficulty
             FROM room_questions rq
             INNER JOIN questions q ON q.id = rq.question_id
             WHERE rq.room_id = ?
               AND rq.question_order = ?
             LIMIT 1`,
            [room.id, questionOrder]
          );

          if (questions.length > 0) {
            const question = questions[0];

            const [options] = await db.execute(
              `SELECT
                qo.id AS option_id,
                qo.option_text,
                rqo.display_order
               FROM room_question_options rqo
               INNER JOIN question_options qo
                 ON qo.id = rqo.option_id
               WHERE rqo.room_question_id = ?
               ORDER BY rqo.display_order ASC`,
              [question.room_question_id]
            );

            socket.emit("game:question_started", {
              question_number: questionOrder,
              total_questions: Number(activeRoom.question_count),
              question_id: question.question_id,
              question_text: question.question_text,
              difficulty: question.difficulty,
              options,
              duration: Number(activeRoom.time_per_question),
              ends_at: activeQuestionEndsAt.get(room.id) || null,
            });
          }
        }
      }

    } catch (error) {
      console.error("room:join error:", error);

      socket.emit("room:error", {
        message: "Gagal bergabung ke room",
      });
    }
  });

  // ========================================
  // ROOM SYNC
  // ========================================

  socket.on("room:sync", async () => {
    try {
      const roomId = socket.data.roomId;

      if (!roomId) return;

      const state = await getRoomState(roomId);

      if (state) {
        socket.emit("room:updated", state);
      }

    } catch (error) {
      console.error("room:sync error:", error);
    }
  });

  // ========================================
  // PLAYER LEAVE ROOM
  // ========================================

  socket.on("room:leave", async () => {
    try {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;

      if (!roomId || !playerId) return;

      await db.execute(
        `UPDATE room_players
         SET is_connected = 0,
             socket_id = NULL
         WHERE id = ?
           AND room_id = ?
           AND socket_id = ?`,
        [playerId, roomId, socket.id]
      );

      socket.leave(`room_${roomId}`);

      socket.emit("room:left", {
        success: true,
      });

      await publishRoomState(roomId);

      socket.data.roomId = null;
      socket.data.playerId = null;

    } catch (error) {
      console.error("room:leave error:", error);
    }
  });

  // ========================================
  // HOST START GAME
  // ========================================

  socket.on("game:start", async () => {
    let connection;
    let transactionStarted = false;

    try {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;

      if (!roomId || !playerId) {
        socket.emit("room:error", {
          message: "Kamu belum bergabung ke room",
        });
        return;
      }

      connection = await db.getConnection();

      await connection.beginTransaction();
      transactionStarted = true;

      const [rooms] = await connection.execute(
        `SELECT *
         FROM game_rooms
         WHERE id = ?
         FOR UPDATE`,
        [roomId]
      );

      if (rooms.length === 0) {
        throw new Error("Room tidak ditemukan");
      }

      const room = rooms[0];

      if (room.status !== "waiting") {
        throw new Error("Kuis sudah dimulai atau selesai");
      }

      const [players] = await connection.execute(
        `SELECT id, is_host
         FROM room_players
         WHERE id = ? AND room_id = ?
         LIMIT 1`,
        [playerId, roomId]
      );

      if (
        players.length === 0 ||
        Number(players[0].is_host) !== 1
      ) {
        throw new Error("Hanya host yang dapat memulai kuis");
      }

      const [playerCount] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM room_players
         WHERE room_id = ? AND is_connected = 1`,
        [roomId]
      );

      if (Number(playerCount[0].total) < 1) {
        throw new Error("Belum ada pemain di room");
      }

      const questionCount = Number(room.question_count);

      const [questions] = await connection.execute(
        `SELECT id
         FROM questions
         ORDER BY RAND()
         LIMIT ?`,
        [questionCount]
      );

      if (questions.length < questionCount) {
        throw new Error("Jumlah soal di database tidak mencukupi");
      }

      // Simpan soal untuk room ini.
      for (let i = 0; i < questions.length; i++) {
        const [result] = await connection.execute(
          `INSERT INTO room_questions
           (room_id, question_id, question_order)
           VALUES (?, ?, ?)`,
          [roomId, questions[i].id, i + 1]
        );

        const roomQuestionId = result.insertId;

        const [options] = await connection.execute(
          `SELECT id
           FROM question_options
           WHERE question_id = ?
           ORDER BY RAND()`,
          [questions[i].id]
        );

        for (let j = 0; j < options.length; j++) {
          await connection.execute(
            `INSERT INTO room_question_options
             (room_question_id, option_id, display_order)
             VALUES (?, ?, ?)`,
            [roomQuestionId, options[j].id, j + 1]
          );
        }
      }

      await connection.execute(
        `UPDATE game_rooms
         SET status = 'playing',
             started_at = NOW(),
             current_question_index = 0
         WHERE id = ?`,
        [roomId]
      );

      await connection.commit();
      transactionStarted = false;

      io.to(`room_${roomId}`).emit("game:started", {
        success: true,
        message: "Kuis dimulai!",
        total_questions: questionCount,
        time_per_question: Number(room.time_per_question),
      });

      console.log(`Room ${roomId}: game dimulai`);

      await publishCurrentQuestion(roomId);

    } catch (error) {
      if (connection && transactionStarted) {
        await connection.rollback();
        transactionStarted = false;
      }

      console.error("game:start error:", error);

      socket.emit("room:error", {
        message: error.message || "Gagal memulai kuis",
      });

    } finally {
      if (connection) {
        connection.release();
      }
    }
  });

  // ========================================
  // PLAYER SUBMIT ANSWER
  // ========================================

  socket.on("game:submit_answer", async (data) => {
    let connection;
    let transactionStarted = false;

    try {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;
      const optionId = Number(data?.option_id);

      if (!roomId || !playerId) {
        socket.emit("game:answer_result", {
          success: false,
          message: "Kamu belum tergabung ke room",
        });
        return;
      }

      if (!Number.isInteger(optionId) || optionId <= 0) {
        socket.emit("game:answer_result", {
          success: false,
          message: "Pilihan jawaban tidak valid",
        });
        return;
      }

      connection = await db.getConnection();

      await connection.beginTransaction();
      transactionStarted = true;

      const [rooms] = await connection.execute(
        `SELECT
          id,
          status,
          question_count,
          time_per_question,
          current_question_index
         FROM game_rooms
         WHERE id = ?
         FOR UPDATE`,
        [roomId]
      );

      if (rooms.length === 0 || rooms[0].status !== "playing") {
        throw new Error("Kuis tidak sedang berlangsung");
      }

      const room = rooms[0];
      const questionOrder =
        Number(room.current_question_index) + 1;

      const endsAt = activeQuestionEndsAt.get(roomId);

      if (!endsAt || Date.now() >= endsAt) {
        throw new Error("Waktu menjawab sudah habis");
      }

      // Ambil soal aktif.
      const [questions] = await connection.execute(
        `SELECT
          rq.id AS room_question_id,
          rq.question_id,
          q.explanation
         FROM room_questions rq
         INNER JOIN questions q ON q.id = rq.question_id
         WHERE rq.room_id = ?
           AND rq.question_order = ?
         LIMIT 1`,
        [roomId, questionOrder]
      );

      if (questions.length === 0) {
        throw new Error("Soal aktif tidak ditemukan");
      }

      const question = questions[0];

      // Validasi pilihan jawaban.
      const [options] = await connection.execute(
        `SELECT qo.id, qo.is_correct
         FROM room_question_options rqo
         INNER JOIN question_options qo
           ON qo.id = rqo.option_id
         WHERE rqo.room_question_id = ?
           AND qo.id = ?
         LIMIT 1`,
        [question.room_question_id, optionId]
      );

      if (options.length === 0) {
        throw new Error("Pilihan tidak sesuai dengan soal aktif");
      }

      // Cegah jawaban ganda.
      const [existingAnswers] = await connection.execute(
        `SELECT id
         FROM game_answers
         WHERE room_id = ?
           AND player_id = ?
           AND question_id = ?
         LIMIT 1`,
        [roomId, playerId, question.question_id]
      );

      if (existingAnswers.length > 0) {
        throw new Error("Kamu sudah menjawab soal ini");
      }

      const isCorrect = Number(options[0].is_correct) === 1;

      const durationMs =
        Number(room.time_per_question) * 1000;

      const remainingMs = Math.max(
        0,
        endsAt - Date.now()
      );

      const answerTimeMs = Math.min(
        durationMs,
        Math.max(0, durationMs - remainingMs)
      );

      const speedBonus = isCorrect
        ? Math.floor((remainingMs / durationMs) * 500)
        : 0;

      const points = isCorrect
        ? 1000 + speedBonus
        : 0;

      // Simpan jawaban.
      await connection.execute(
        `INSERT INTO game_answers
         (
           room_id,
           player_id,
           question_id,
           selected_option_id,
           is_correct,
           points,
           answer_time_ms,
           answered_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          roomId,
          playerId,
          question.question_id,
          optionId,
          isCorrect ? 1 : 0,
          points,
          answerTimeMs,
        ]
      );

      // Perbarui skor.
      await connection.execute(
        `UPDATE room_players
         SET score = score + ?
         WHERE id = ? AND room_id = ?`,
        [points, playerId, roomId]
      );

      await connection.commit();
      transactionStarted = false;

      socket.emit("game:answer_result", {
        success: true,
        is_correct: isCorrect,
        points,
        explanation: question.explanation,
        message: isCorrect
          ? "Jawaban benar!"
          : "Jawaban belum tepat",
      });

      // Kirim leaderboard terbaru.
      const [leaderboard] = await db.execute(
        `SELECT
          id AS player_id,
          nickname,
          score,
          is_host
         FROM room_players
         WHERE room_id = ?
         ORDER BY score DESC, joined_at ASC`,
        [roomId]
      );

      io.to(`room_${roomId}`).emit("game:leaderboard", {
        question_number: questionOrder,
        players: leaderboard,
      });

      console.log(
        `Pemain ${playerId} menjawab soal ${questionOrder}: ${points} poin`
      );

    } catch (error) {
      if (connection && transactionStarted) {
        await connection.rollback();
        transactionStarted = false;
      }

      console.error("game:submit_answer error:", error);

      socket.emit("game:answer_result", {
        success: false,
        message: error.message || "Gagal menyimpan jawaban",
      });

    } finally {
      if (connection) {
        connection.release();
      }
    }
  });

  // ========================================
  // SOCKET DISCONNECT
  // ========================================

  socket.on("disconnect", async () => {
    console.log("Socket terputus:", socket.id);

    try {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;

      if (!roomId || !playerId) return;

      await db.execute(
        `UPDATE room_players
         SET is_connected = 0,
             socket_id = NULL
         WHERE id = ?
           AND room_id = ?
           AND socket_id = ?`,
        [playerId, roomId, socket.id]
      );

      io.to(`room_${roomId}`).emit("room:player_left", {
        player_id: playerId,
      });

      await publishRoomState(roomId);

    } catch (error) {
      console.error("disconnect error:", error);
    }
  });
});

// ==========================================
// START SERVER
// ==========================================

httpServer.listen(PORT, async () => {
  console.log("----------------------------------");
  console.log("INFORMATICS QUIZ ARENA BACKEND");
  console.log(`Server berjalan di port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log("Health Check: /health");
  console.log("Socket.IO: Aktif");
  console.log("Game Start: Aktif");
  console.log("Game Answer: Aktif");
  console.log("Leaderboard: Aktif");
  console.log("----------------------------------");

  await testDatabaseConnection();
});
