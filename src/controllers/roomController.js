
import db from "../config/database.js";
import { randomInt } from "crypto";

// ========================================
// GENERATE KODE ROOM
// ========================================
function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 6; i++) {
        code += characters[randomInt(characters.length)];
    }

    return code;
}

// ========================================
// VALIDASI BOOLEAN
// ========================================
function isValidBoolean(value) {
    return typeof value === "boolean";
}

// ========================================
// POST /api/rooms
// MEMBUAT ROOM BARU
// ========================================
export const createRoom = async (req, res) => {
    const {
        nickname,
        question_count = 25,
        time_per_question = 20,
        enable_combo = false,
        enable_powerup = false
    } = req.body;

    if (!nickname || typeof nickname !== "string" || !nickname.trim()) {
        return res.status(400).json({
            success: false,
            message: "Nickname wajib diisi"
        });
    }

    const cleanNickname = nickname.trim();

    if (cleanNickname.length > 20) {
        return res.status(400).json({
            success: false,
            message: "Nickname maksimal 20 karakter"
        });
    }

    const questionCount = Number(question_count);
    const timePerQuestion = Number(time_per_question);

    if (
        !Number.isInteger(questionCount) ||
        questionCount < 1 ||
        questionCount > 50
    ) {
        return res.status(400).json({
            success: false,
            message: "Jumlah soal harus antara 1 sampai 50"
        });
    }

    if (
        !Number.isInteger(timePerQuestion) ||
        timePerQuestion < 5 ||
        timePerQuestion > 120
    ) {
        return res.status(400).json({
            success: false,
            message: "Waktu per soal harus antara 5 sampai 120 detik"
        });
    }

    if (
        !isValidBoolean(enable_combo) ||
        !isValidBoolean(enable_powerup)
    ) {
        return res.status(400).json({
            success: false,
            message: "Pengaturan Combo dan Power-Up harus berupa boolean"
        });
    }

    let client;

    try {
        client = await db.connect();

        await client.query("BEGIN");

        let room;
        let roomCode;

        
        // Membuat kode room unik maksimal 5 kali.
        for (let attempt = 0; attempt < 5; attempt++) {
            roomCode = generateRoomCode();

            const roomResult = await client.query(
                `INSERT INTO game_rooms
                (
                    room_code,
                    status,
                    max_players,
                    question_count,
                    time_per_question,
                    current_question_index,
                    enable_combo,
                    enable_powerup
                )
                VALUES ($1, 'waiting', 50, $2, $3, 0, $4, $5)
                ON CONFLICT (room_code) DO NOTHING
                RETURNING id`,
                [
                    roomCode,
                    questionCount,
                    timePerQuestion,
                    enable_combo,
                    enable_powerup
                ]
            );

            if (roomResult.rows.length > 0) {
                room = roomResult.rows[0];
                break;
            }
        }

        if (!room) {
            throw new Error(
                "Gagal membuat kode room unik. Silakan coba lagi."
            );
        }


        const playerResult = await client.query(
            `INSERT INTO room_players
            (
                room_id,
                nickname,
                socket_id,
                score,
                is_host,
                is_connected
            )
            VALUES ($1, $2, NULL, 0, TRUE, TRUE)
            RETURNING id`,
            [room.id, cleanNickname]
        );

        const player = playerResult.rows[0];

        await client.query("COMMIT");

        return res.status(201).json({
            success: true,
            message: "Room berhasil dibuat",
            data: {
                room_id: room.id,
                room_code: roomCode,
                status: "waiting",
                max_players: 50,
                question_count: questionCount,
                time_per_question: timePerQuestion,
                enable_combo,
                enable_powerup,
                game_mode:
                    enable_combo && enable_powerup
                        ? "ultimate_battle"
                        : enable_combo
                            ? "combo_battle"
                            : enable_powerup
                                ? "power_battle"
                                : "classic",
                player: {
                    player_id: player.id,
                    nickname: cleanNickname,
                    is_host: true,
                    score: 0
                }
            }
        });

    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError.message);
            }
        }

        console.error("Error createRoom:", error);

        return res.status(500).json({
            success: false,
            message: "Gagal membuat room"
        });

    } finally {
        if (client) {
            client.release();
        }
    }
};

// ========================================
// POST /api/rooms/join
// BERGABUNG KE ROOM
// ========================================
export const joinRoom = async (req, res) => {
    const { room_code, nickname } = req.body;

    if (!room_code || typeof room_code !== "string" || !room_code.trim()) {
        return res.status(400).json({
            success: false,
            message: "Kode room wajib diisi"
        });
    }

    if (!nickname || typeof nickname !== "string" || !nickname.trim()) {
        return res.status(400).json({
            success: false,
            message: "Nickname wajib diisi"
        });
    }

    const cleanRoomCode = room_code.trim().toUpperCase();
    const cleanNickname = nickname.trim();

    if (cleanNickname.length > 20) {
        return res.status(400).json({
            success: false,
            message: "Nickname maksimal 20 karakter"
        });
    }

    let client;

    try {
        client = await db.connect();

        await client.query("BEGIN");

        const roomResult = await client.query(
            `SELECT
                id,
                room_code,
                status,
                max_players,
                question_count,
                time_per_question,
                enable_combo,
                enable_powerup
             FROM game_rooms
             WHERE room_code = $1
             FOR UPDATE`,
            [cleanRoomCode]
        );

        if (roomResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "Room tidak ditemukan"
            });
        }

        const room = roomResult.rows[0];

        if (room.status !== "waiting") {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Room sudah dimulai atau telah selesai"
            });
        }

        const playerCountResult = await client.query(
            `SELECT COUNT(*) AS total_players
             FROM room_players
             WHERE room_id = $1
             AND is_connected = TRUE`,
            [room.id]
        );

        const totalPlayers = Number(
            playerCountResult.rows[0].total_players
        );

        if (totalPlayers >= room.max_players) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Room sudah penuh"
            });
        }

        const existingPlayerResult = await client.query(
            `SELECT id
             FROM room_players
             WHERE room_id = $1
             AND LOWER(nickname) = LOWER($2)
             AND is_connected = TRUE`,
            [room.id, cleanNickname]
        );

        if (existingPlayerResult.rows.length > 0) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                success: false,
                message: "Nickname sudah digunakan di room ini"
            });
        }

        const playerResult = await client.query(
            `INSERT INTO room_players
            (
                room_id,
                nickname,
                socket_id,
                score,
                is_host,
                is_connected
            )
            VALUES ($1, $2, NULL, 0, FALSE, TRUE)
            RETURNING id`,
            [room.id, cleanNickname]
        );

        const player = playerResult.rows[0];

        await client.query("COMMIT");

        return res.status(201).json({
            success: true,
            message: "Berhasil bergabung ke room",
            data: {
                room_id: room.id,
                room_code: room.room_code,
                status: room.status,
                max_players: room.max_players,
                question_count: room.question_count,
                time_per_question: room.time_per_question,
                enable_combo: room.enable_combo,
                enable_powerup: room.enable_powerup,
                game_mode:
                    room.enable_combo && room.enable_powerup
                        ? "ultimate_battle"
                        : room.enable_combo
                            ? "combo_battle"
                            : room.enable_powerup
                                ? "power_battle"
                                : "classic",
                total_players: totalPlayers + 1,
                player: {
                    player_id: player.id,
                    nickname: cleanNickname,
                    is_host: false,
                    score: 0
                }
            }
        });

    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError.message);
            }
        }

        console.error("Error joinRoom:", error);

        return res.status(500).json({
            success: false,
            message: "Gagal bergabung ke room"
        });

    } finally {
        if (client) {
            client.release();
        }
    }
};
