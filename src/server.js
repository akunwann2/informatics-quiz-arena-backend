
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
const HOST = "0.0.0.0";

// ==========================================
// SOCKET.IO CONFIGURATION
// ==========================================

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
});

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors({
    origin: "*",
    methods: [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
    ],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// REST API
// ==========================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "IF Quizz Backend aktif!",
        status: "online",
    });
});

app.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "IF Quizz Backend aktif!",
        status: "online",
        socket_io: "active",
    });
});

app.use("/api", questionRoutes);
app.use("/api/rooms", roomRoutes);

// ==========================================
// JSON 404 HANDLER
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

// Menyimpan timer setiap room.
const gameTimers = new Map();

// Menyimpan waktu berakhirnya soal berdasarkan jam server.
const activeQuestionEndsAt = new Map();

// Mencegah dua proses memindahkan soal yang sama.
const advancingRooms = new Set();

// ==========================================
// HELPER: ROOM STATE
// ==========================================

async function getRoomState(roomId) {
    const roomResult = await db.query(
        `SELECT
            id,
            room_code,
            status,
            max_players,
            question_count,
            time_per_question,
            current_question_index
         FROM game_rooms
         WHERE id = $1
         LIMIT 1`,
        [roomId]
    );

    if (roomResult.rows.length === 0) {
        return null;
    }

    const playerResult = await db.query(
        `SELECT
            id AS player_id,
            nickname,
            score,
            is_host,
            is_connected
         FROM room_players
         WHERE room_id = $1
         ORDER BY is_host DESC, joined_at ASC`,
        [roomId]
    );

    return {
        room: roomResult.rows[0],
        players: playerResult.rows,
    };
}

// ==========================================
// HELPER: PUBLISH ROOM STATE
// ==========================================

async function publishRoomState(roomId) {
    const state = await getRoomState(roomId);

    if (state) {
        io.to(`room_${roomId}`).emit(
            "room:updated",
            state
        );
    }
}

// ==========================================
// HELPER: CLEAR ROOM TIMER
// ==========================================

function clearRoomTimer(roomId) {
    const timer = gameTimers.get(roomId);

    if (timer) {
        clearTimeout(timer);
        gameTimers.delete(roomId);
    }

    activeQuestionEndsAt.delete(roomId);
}

// ==========================================
// HELPER: PUBLISH CURRENT QUESTION
// ==========================================

async function publishCurrentQuestion(roomId) {
    try {
        const roomResult = await db.query(
            `SELECT
                id,
                status,
                question_count,
                time_per_question,
                current_question_index
             FROM game_rooms
             WHERE id = $1
             LIMIT 1`,
            [roomId]
        );

        if (
            roomResult.rows.length === 0 ||
            roomResult.rows[0].status !== "playing"
        ) {
            return;
        }

        const room = roomResult.rows[0];

        const questionOrder =
            Number(room.current_question_index) + 1;

        // Ambil soal yang sudah disiapkan untuk room.
        const questionResult = await db.query(
            `SELECT
                rq.id AS room_question_id,
                rq.question_id,
                q.question_text,
                q.difficulty,
                q.explanation
             FROM room_questions rq
             INNER JOIN questions q
                ON q.id = rq.question_id
             WHERE rq.room_id = $1
               AND rq.question_order = $2
             LIMIT 1`,
            [roomId, questionOrder]
        );

        if (questionResult.rows.length === 0) {
            await finishGame(roomId);
            return;
        }

        const question = questionResult.rows[0];

        // Ambil pilihan jawaban.
        const optionResult = await db.query(
            `SELECT
                qo.id AS option_id,
                qo.option_text,
                rqo.display_order
             FROM room_question_options rqo
             INNER JOIN question_options qo
                ON qo.id = rqo.option_id
             WHERE rqo.room_question_id = $1
             ORDER BY rqo.display_order ASC`,
            [question.room_question_id]
        );

        const duration = Number(room.time_per_question);

        // Semua pemain menggunakan waktu akhir yang sama.
        const endsAt = Date.now() + duration * 1000;

        activeQuestionEndsAt.set(roomId, endsAt);

        // Kirim soal ke seluruh pemain secara bersamaan.
        // Tidak mengirim kunci jawaban atau penjelasan.
        io.to(`room_${roomId}`).emit(
            "game:question_started",
            {
                question_number: questionOrder,
                total_questions: Number(room.question_count),
                question_id: question.question_id,
                question_text: question.question_text,
                difficulty: question.difficulty,
                options: optionResult.rows,
                duration,
                ends_at: endsAt,
            }
        );

        console.log(
            `Room ${roomId}: soal ${questionOrder} dimulai`
        );

        // Bersihkan timer sebelumnya.
        const oldTimer = gameTimers.get(roomId);

        if (oldTimer) {
            clearTimeout(oldTimer);
        }

        // Timer tetap berjalan meskipun pemain sudah menjawab.
        const timer = setTimeout(async () => {
            gameTimers.delete(roomId);
            activeQuestionEndsAt.delete(roomId);

            await advanceGame(roomId);
        }, duration * 1000);

        gameTimers.set(roomId, timer);

    } catch (error) {
        console.error(
            "publishCurrentQuestion error:",
            error
        );
    }
}

// ==========================================
// HELPER: ADVANCE GAME
// ==========================================

async function advanceGame(roomId) {
    // Hindari perpindahan soal ganda.
    if (advancingRooms.has(roomId)) {
        return;
    }

    advancingRooms.add(roomId);

    try {
        const roomResult = await db.query(
            `SELECT
                id,
                status,
                question_count,
                current_question_index
             FROM game_rooms
             WHERE id = $1
             LIMIT 1`,
            [roomId]
        );

        if (
            roomResult.rows.length === 0 ||
            roomResult.rows[0].status !== "playing"
        ) {
            return;
        }

        const room = roomResult.rows[0];

        const nextIndex =
            Number(room.current_question_index) + 1;

        // Jika seluruh soal sudah selesai.
        if (nextIndex >= Number(room.question_count)) {
            await finishGame(roomId);
            return;
        }

        // Perbarui indeks soal.
        await db.query(
            `UPDATE game_rooms
             SET current_question_index = $1
             WHERE id = $2
               AND status = 'playing'`,
            [
                nextIndex,
                roomId,
            ]
        );

        // Langsung kirim soal berikutnya.
        await publishCurrentQuestion(roomId);

    } catch (error) {
        console.error(
            "advanceGame error:",
            error
        );

    } finally {
        advancingRooms.delete(roomId);
    }
}

// ==========================================
// HELPER: FINISH GAME
// ==========================================

async function finishGame(roomId) {
    try {
        clearRoomTimer(roomId);

        // Tandai pertandingan selesai.
        // RETURNING mencegah pengiriman hasil berulang.
        const finishResult = await db.query(
            `UPDATE game_rooms
             SET status = 'finished',
                 ended_at = NOW()
             WHERE id = $1
               AND status = 'playing'
             RETURNING id`,
            [roomId]
        );

        // Jika room sudah selesai sebelumnya, hentikan proses.
        if (finishResult.rows.length === 0) {
            return;
        }

        // Ambil leaderboard akhir.
        const leaderboardResult = await db.query(
            `SELECT
                id AS player_id,
                nickname,
                score,
                is_host
             FROM room_players
             WHERE room_id = $1
             ORDER BY score DESC, joined_at ASC`,
            [roomId]
        );

        // Ambil semua socket pemain yang berada di room.
        const sockets = await io
            .in(`room_${roomId}`)
            .fetchSockets();

        // Kirim riwayat jawaban secara pribadi ke setiap pemain.
        for (const playerSocket of sockets) {
            const playerId = Number(
                playerSocket.data.playerId
            );

            if (
                !Number.isInteger(playerId) ||
                playerId <= 0
            ) {
                continue;
            }

            const reviewResult = await db.query(
                `SELECT
                    rq.question_order,
                    q.id AS question_id,
                    q.question_text,
                    q.explanation,
                    selected.option_text AS selected_answer,
                    correct.option_text AS correct_answer,
                    ga.is_correct,
                    ga.points
                 FROM game_answers ga
                 INNER JOIN questions q
                    ON q.id = ga.question_id
                 INNER JOIN room_questions rq
                    ON rq.room_id = ga.room_id
                   AND rq.question_id = ga.question_id
                 INNER JOIN question_options selected
                    ON selected.id = ga.selected_option_id
                 INNER JOIN question_options correct
                    ON correct.question_id = ga.question_id
                   AND correct.is_correct = TRUE
                 WHERE ga.room_id = $1
                   AND ga.player_id = $2
                 ORDER BY rq.question_order ASC`,
                [
                    roomId,
                    playerId,
                ]
            );

            // Setiap pemain hanya menerima riwayat jawabannya sendiri.
            playerSocket.emit("game:finished", {
                message: "Kuis telah selesai!",
                leaderboard: leaderboardResult.rows,
                answer_reviews: reviewResult.rows,
            });
        }

        console.log(
            `Room ${roomId}: kuis selesai`
        );

    } catch (error) {
        console.error(
            "finishGame error:",
            error
        );
    }
}

// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", (socket) => {
    console.log(
        "Socket terhubung:",
        socket.id
    );

    // ======================================
    // ROOM JOIN
    // ======================================

    socket.on("room:join", async (data) => {
        try {
            const roomCode = String(
                data?.room_code || ""
            )
                .trim()
                .toUpperCase();

            const playerId = Number(data?.player_id);

            if (
                !roomCode ||
                !Number.isInteger(playerId) ||
                playerId <= 0
            ) {
                socket.emit("room:error", {
                    message: "Data room atau pemain tidak valid",
                });
                return;
            }

            const roomResult = await db.query(
                `SELECT
                    id,
                    room_code,
                    status
                 FROM game_rooms
                 WHERE room_code = $1
                 LIMIT 1`,
                [roomCode]
            );

            if (roomResult.rows.length === 0) {
                socket.emit("room:error", {
                    message: "Room tidak ditemukan",
                });
                return;
            }

            const room = roomResult.rows[0];

            if (room.status === "finished") {
                socket.emit("room:error", {
                    message: "Kuis sudah selesai",
                });
                return;
            }

            const playerResult = await db.query(
                `SELECT
                    id,
                    nickname,
                    is_host
                 FROM room_players
                 WHERE id = $1
                   AND room_id = $2
                 LIMIT 1`,
                [
                    playerId,
                    room.id,
                ]
            );

            if (playerResult.rows.length === 0) {
                socket.emit("room:error", {
                    message: "Pemain tidak terdaftar di room ini",
                });
                return;
            }

            const player = playerResult.rows[0];

            socket.data.roomId = room.id;
            socket.data.playerId = playerId;

            await db.query(
                `UPDATE room_players
                 SET socket_id = $1,
                     is_connected = TRUE
                 WHERE id = $2
                   AND room_id = $3`,
                [
                    socket.id,
                    playerId,
                    room.id,
                ]
            );

            await socket.join(`room_${room.id}`);

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

            // Jika pemain masuk kembali saat game berlangsung,
            // kirim soal aktif dan waktu akhir dari server.
            if (room.status === "playing") {
                const activeRoomResult = await db.query(
                    `SELECT
                        question_count,
                        time_per_question,
                        current_question_index
                     FROM game_rooms
                     WHERE id = $1
                     LIMIT 1`,
                    [room.id]
                );

                if (activeRoomResult.rows.length > 0) {
                    const activeRoom =
                        activeRoomResult.rows[0];

                    const questionOrder =
                        Number(
                            activeRoom.current_question_index
                        ) + 1;

                    const questionResult = await db.query(
                        `SELECT
                            rq.id AS room_question_id,
                            rq.question_id,
                            q.question_text,
                            q.difficulty
                         FROM room_questions rq
                         INNER JOIN questions q
                            ON q.id = rq.question_id
                         WHERE rq.room_id = $1
                           AND rq.question_order = $2
                         LIMIT 1`,
                        [
                            room.id,
                            questionOrder,
                        ]
                    );

                    if (questionResult.rows.length > 0) {
                        const question =
                            questionResult.rows[0];

                        const optionResult = await db.query(
                            `SELECT
                                qo.id AS option_id,
                                qo.option_text,
                                rqo.display_order
                             FROM room_question_options rqo
                             INNER JOIN question_options qo
                                ON qo.id = rqo.option_id
                             WHERE rqo.room_question_id = $1
                             ORDER BY rqo.display_order ASC`,
                            [question.room_question_id]
                        );

                        socket.emit(
                            "game:question_started",
                            {
                                question_number: questionOrder,
                                total_questions: Number(
                                    activeRoom.question_count
                                ),
                                question_id: question.question_id,
                                question_text: question.question_text,
                                difficulty: question.difficulty,
                                options: optionResult.rows,
                                duration: Number(
                                    activeRoom.time_per_question
                                ),
                                ends_at:
                                    activeQuestionEndsAt.get(
                                        room.id
                                    ) || null,
                            }
                        );
                    }
                }
            }

        } catch (error) {
            console.error(
                "room:join error:",
                error
            );

            socket.emit("room:error", {
                message: "Gagal bergabung ke room",
            });
        }
    });

    // ======================================
    // ROOM SYNC
    // ======================================

    socket.on("room:sync", async () => {
        try {
            const roomId = socket.data.roomId;

            if (!roomId) return;

            const state = await getRoomState(roomId);

            if (state) {
                socket.emit("room:updated", state);
            }

        } catch (error) {
            console.error(
                "room:sync error:",
                error
            );
        }
    });

    // ======================================
    // ROOM LEAVE
    // ======================================

    socket.on("room:leave", async () => {
        try {
            const roomId = socket.data.roomId;
            const playerId = socket.data.playerId;

            if (!roomId || !playerId) return;

            await db.query(
                `UPDATE room_players
                 SET is_connected = FALSE,
                     socket_id = NULL
                 WHERE id = $1
                   AND room_id = $2
                   AND socket_id = $3`,
                [
                    playerId,
                    roomId,
                    socket.id,
                ]
            );

            await socket.leave(`room_${roomId}`);

            socket.emit("room:left", {
                success: true,
            });

            await publishRoomState(roomId);

            socket.data.roomId = null;
            socket.data.playerId = null;

        } catch (error) {
            console.error(
                "room:leave error:",
                error
            );
        }
    });

    // ======================================
    // GAME START
    // ======================================

    socket.on("game:start", async () => {
        let client;
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

            client = await db.connect();

            await client.query("BEGIN");
            transactionStarted = true;

            const roomResult = await client.query(
                `SELECT *
                 FROM game_rooms
                 WHERE id = $1
                 FOR UPDATE`,
                [roomId]
            );

            if (roomResult.rows.length === 0) {
                throw new Error("Room tidak ditemukan");
            }

            const room = roomResult.rows[0];

            if (room.status !== "waiting") {
                throw new Error(
                    "Kuis sudah dimulai atau selesai"
                );
            }

            const playerResult = await client.query(
                `SELECT
                    id,
                    is_host
                 FROM room_players
                 WHERE id = $1
                   AND room_id = $2
                 LIMIT 1`,
                [
                    playerId,
                    roomId,
                ]
            );

            if (
                playerResult.rows.length === 0 ||
                playerResult.rows[0].is_host !== true
            ) {
                throw new Error(
                    "Hanya host yang dapat memulai kuis"
                );
            }

            const playerCountResult = await client.query(
                `SELECT COUNT(*) AS total
                 FROM room_players
                 WHERE room_id = $1
                   AND is_connected = TRUE`,
                [roomId]
            );

            if (
                Number(playerCountResult.rows[0].total) < 1
            ) {
                throw new Error(
                    "Belum ada pemain di room"
                );
            }

            const questionCount =
                Number(room.question_count);

            // Pilih soal secara acak.
            const questionResult = await client.query(
                `SELECT id
                 FROM questions
                 ORDER BY RANDOM()
                 LIMIT $1`,
                [questionCount]
            );

            const questions = questionResult.rows;

            if (questions.length < questionCount) {
                throw new Error(
                    "Jumlah soal di database tidak mencukupi"
                );
            }

            // Siapkan soal dan pilihan untuk room.
            // Tidak ada DELETE FROM room_questions di sini.
            for (let i = 0; i < questions.length; i++) {
                const roomQuestionResult =
                    await client.query(
                        `INSERT INTO room_questions
                         (
                            room_id,
                            question_id,
                            question_order
                         )
                         VALUES ($1, $2, $3)
                         RETURNING id`,
                        [
                            roomId,
                            questions[i].id,
                            i + 1,
                        ]
                    );

                const roomQuestionId =
                    roomQuestionResult.rows[0].id;

                const optionResult = await client.query(
                    `SELECT id
                     FROM question_options
                     WHERE question_id = $1
                     ORDER BY RANDOM()`,
                    [questions[i].id]
                );

                const options = optionResult.rows;

                for (let j = 0; j < options.length; j++) {
                    await client.query(
                        `INSERT INTO room_question_options
                         (
                            room_question_id,
                            option_id,
                            display_order
                         )
                         VALUES ($1, $2, $3)`,
                        [
                            roomQuestionId,
                            options[j].id,
                            j + 1,
                        ]
                    );
                }
            }

            await client.query(
                `UPDATE game_rooms
                 SET status = 'playing',
                     started_at = NOW(),
                     current_question_index = 0
                 WHERE id = $1`,
                [roomId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            io.to(`room_${roomId}`).emit(
                "game:started",
                {
                    success: true,
                    message: "Kuis dimulai!",
                    total_questions: questionCount,
                    time_per_question: Number(
                        room.time_per_question
                    ),
                }
            );

            console.log(
                `Room ${roomId}: game dimulai`
            );

            // Publikasikan soal pertama.
            await publishCurrentQuestion(roomId);

        } catch (error) {
            if (client && transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }

            console.error(
                "game:start error:",
                error
            );

            socket.emit("room:error", {
                message:
                    error.message ||
                    "Gagal memulai kuis",
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    });

    // ======================================
    // GAME SUBMIT ANSWER
    // ======================================

    socket.on("game:submit_answer", async (data) => {
        let client;
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

            client = await db.connect();

            await client.query("BEGIN");
            transactionStarted = true;

            // Kunci data room agar proses jawaban
            // tidak bertabrakan dengan perpindahan soal.
            const roomResult = await client.query(
                `SELECT
                    id,
                    status,
                    question_count,
                    time_per_question,
                    current_question_index
                 FROM game_rooms
                 WHERE id = $1
                 FOR UPDATE`,
                [roomId]
            );

            if (
                roomResult.rows.length === 0 ||
                roomResult.rows[0].status !== "playing"
            ) {
                throw new Error("Kuis tidak sedang berlangsung");
            }

            const room = roomResult.rows[0];

            const questionOrder =
                Number(room.current_question_index) + 1;

            const endsAt = activeQuestionEndsAt.get(roomId);

            // Validasi waktu berdasarkan jam server.
            if (!endsAt || Date.now() >= endsAt) {
                throw new Error("Waktu menjawab sudah habis");
            }

            const questionResult = await client.query(
                `SELECT
                    rq.id AS room_question_id,
                    rq.question_id,
                    q.explanation
                 FROM room_questions rq
                 INNER JOIN questions q
                    ON q.id = rq.question_id
                 WHERE rq.room_id = $1
                   AND rq.question_order = $2
                 LIMIT 1`,
                [roomId, questionOrder]
            );

            if (questionResult.rows.length === 0) {
                throw new Error("Soal aktif tidak ditemukan");
            }

            const question = questionResult.rows[0];

            const optionResult = await client.query(
                `SELECT
                    qo.id,
                    qo.is_correct
                 FROM room_question_options rqo
                 INNER JOIN question_options qo
                    ON qo.id = rqo.option_id
                 WHERE rqo.room_question_id = $1
                   AND qo.id = $2
                 LIMIT 1`,
                [question.room_question_id, optionId]
            );

            if (optionResult.rows.length === 0) {
                throw new Error(
                    "Pilihan tidak sesuai dengan soal aktif"
                );
            }

            // Pastikan pemain belum menjawab soal ini.
            const existingAnswerResult = await client.query(
                `SELECT id
                 FROM game_answers
                 WHERE room_id = $1
                   AND player_id = $2
                   AND question_id = $3
                 LIMIT 1`,
                [
                    roomId,
                    playerId,
                    question.question_id,
                ]
            );

            if (existingAnswerResult.rows.length > 0) {
                throw new Error("Kamu sudah menjawab soal ini");
            }

            const isCorrect =
                optionResult.rows[0].is_correct === true;

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
                ? Math.floor(
                    (remainingMs / durationMs) * 500
                )
                : 0;

            const points = isCorrect
                ? 1000 + speedBonus
                : 0;

            // Simpan jawaban dan hasil penilaiannya ke database.
            // Informasi ini tidak dikirim ke pemain saat pertandingan.
            await client.query(
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
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                [
                    roomId,
                    playerId,
                    question.question_id,
                    optionId,
                    isCorrect,
                    points,
                    answerTimeMs,
                ]
            );

            await client.query(
                `UPDATE room_players
                 SET score = score + $1
                 WHERE id = $2
                   AND room_id = $3`,
                [
                    points,
                    playerId,
                    roomId,
                ]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            // Respons netral.
            // Tidak mengirim benar/salah, poin, atau penjelasan.
            socket.emit("game:answer_result", {
                success: true,
                message: "Jawaban berhasil dicatat.",
                ends_at: endsAt,
            });

            // Perbarui leaderboard semua pemain.
            const leaderboardResult = await db.query(
                `SELECT
                    id AS player_id,
                    nickname,
                    score,
                    is_host
                 FROM room_players
                 WHERE room_id = $1
                 ORDER BY score DESC, joined_at ASC`,
                [roomId]
            );

            io.to(`room_${roomId}`).emit(
                "game:leaderboard",
                {
                    question_number: questionOrder,
                    players: leaderboardResult.rows,
                }
            );

            console.log(
                `Pemain ${playerId} menjawab soal ${questionOrder}. Jawaban tersimpan.`
            );

        } catch (error) {
            if (client && transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }

            console.error(
                "game:submit_answer error:",
                error
            );

            socket.emit("game:answer_result", {
                success: false,
                message:
                    error.message ||
                    "Gagal menyimpan jawaban",
            });

        } finally {
            if (client) {
                client.release();
            }
        }
    });

    // ======================================
    // DISCONNECT
    // ======================================

    socket.on("disconnect", async () => {
        console.log("Socket terputus:", socket.id);

        try {
            const roomId = socket.data.roomId;
            const playerId = socket.data.playerId;

            if (!roomId || !playerId) return;

            await db.query(
                `UPDATE room_players
                 SET is_connected = FALSE,
                     socket_id = NULL
                 WHERE id = $1
                   AND room_id = $2
                   AND socket_id = $3`,
                [
                    playerId,
                    roomId,
                    socket.id,
                ]
            );

            io.to(`room_${roomId}`).emit(
                "room:player_left",
                {
                    player_id: playerId,
                }
            );

            await publishRoomState(roomId);

        } catch (error) {
            console.error("disconnect error:", error);
        }
    });
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
    try {
        const connected = await testDatabaseConnection();

        if (!connected) {
            console.error(
                "Server tidak dijalankan karena database gagal terhubung."
            );
            process.exit(1);
        }

        httpServer.listen(PORT, HOST, () => {
            console.log("----------------------------------");
            console.log("IF QUIZZ BACKEND");
            console.log(`Server berjalan pada ${HOST}:${PORT}`);
            console.log(`Port: ${PORT}`);
            console.log("Health Check: /health");
            console.log("Socket.IO: Aktif");
            console.log("Game Start: Aktif");
            console.log("Game Answer: Aktif");
            console.log("Leaderboard: Aktif");
            console.log("Answer Review: Aktif");
            console.log("Shared Server Timer: Aktif");
            console.log("Question Preloading: Aktif");
            console.log("----------------------------------");
        });

    } catch (error) {
        console.error(
            "Gagal menjalankan server:",
            error
        );
        process.exit(1);
    }
}

startServer();
