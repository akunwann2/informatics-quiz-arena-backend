
import db from "../config/database.js";
import { randomInt } from "crypto";

// Membuat kode room acak 6 karakter.
function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 6; i++) {
        code += characters[randomInt(characters.length)];
    }

    return code;
}

// POST /api/rooms
// Membuat room baru dan menjadikan pembuatnya sebagai host.
export const createRoom = async (req, res) => {
    const { nickname, question_count = 25, time_per_question = 20 } = req.body;

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

    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) {
        return res.status(400).json({
            success: false,
            message: "Jumlah soal harus antara 1 sampai 50"
        });
    }

    if (!Number.isInteger(timePerQuestion) || timePerQuestion < 5 || timePerQuestion > 120) {
        return res.status(400).json({
            success: false,
            message: "Waktu per soal harus antara 5 sampai 120 detik"
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let roomId;
        let roomCode;
        let roomCreated = false;

        // Coba membuat kode room sampai maksimal 5 kali.
        for (let attempt = 0; attempt < 5; attempt++) {
            roomCode = generateRoomCode();

            try {
                const [result] = await connection.execute(
                    `INSERT INTO game_rooms
                    (room_code, status, max_players, question_count, time_per_question, current_question_index)
                    VALUES (?, 'waiting', 50, ?, ?, 0)`,
                    [roomCode, questionCount, timePerQuestion]
                );

                roomId = result.insertId;
                roomCreated = true;
                break;
            } catch (error) {
                if (error.code !== "ER_DUP_ENTRY") {
                    throw error;
                }
            }
        }

        if (!roomCreated) {
            throw new Error("Gagal membuat kode room unik. Silakan coba lagi.");
        }

        const [playerResult] = await connection.execute(
            `INSERT INTO room_players
            (room_id, nickname, socket_id, score, is_host, is_connected)
            VALUES (?, ?, NULL, 0, 1, 1)`,
            [roomId, cleanNickname]
        );

        await connection.commit();

        return res.status(201).json({
            success: true,
            message: "Room berhasil dibuat",
            data: {
                room_id: roomId,
                room_code: roomCode,
                status: "waiting",
                max_players: 50,
                question_count: questionCount,
                time_per_question: timePerQuestion,
                player: {
                    player_id: playerResult.insertId,
                    nickname: cleanNickname,
                    is_host: true,
                    score: 0
                }
            }
        });

    } catch (error) {
        await connection.rollback();

        console.error("Error createRoom:", error);

        return res.status(500).json({
            success: false,
            message: "Gagal membuat room"
        });

    } finally {
        connection.release();
    }
};


// POST /api/rooms/join
// Bergabung ke room menggunakan kode room.
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

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Kunci data room sementara agar kapasitas tidak terlampaui
        // ketika beberapa pemain bergabung bersamaan.
        const [rooms] = await connection.execute(
            `SELECT id, room_code, status, max_players, question_count, time_per_question
             FROM game_rooms
             WHERE room_code = ?
             FOR UPDATE`,
            [cleanRoomCode]
        );

        if (rooms.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Room tidak ditemukan"
            });
        }

        const room = rooms[0];

        if (room.status !== "waiting") {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Room sudah dimulai atau telah selesai"
            });
        }

        // Hitung pemain yang sedang terdaftar aktif.
        const [playerCounts] = await connection.execute(
            `SELECT COUNT(*) AS total_players
             FROM room_players
             WHERE room_id = ? AND is_connected = 1`,
            [room.id]
        );

        const totalPlayers = Number(playerCounts[0].total_players);

        if (totalPlayers >= room.max_players) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Room sudah penuh"
            });
        }

        // Cegah dua pemain aktif menggunakan nickname yang sama.
        const [existingPlayers] = await connection.execute(
            `SELECT id
             FROM room_players
             WHERE room_id = ?
             AND LOWER(nickname) = LOWER(?)
             AND is_connected = 1`,
            [room.id, cleanNickname]
        );

        if (existingPlayers.length > 0) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Nickname sudah digunakan di room ini"
            });
        }

        const [playerResult] = await connection.execute(
            `INSERT INTO room_players
            (room_id, nickname, socket_id, score, is_host, is_connected)
            VALUES (?, ?, NULL, 0, 0, 1)`,
            [room.id, cleanNickname]
        );

        await connection.commit();

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
                total_players: totalPlayers + 1,
                player: {
                    player_id: playerResult.insertId,
                    nickname: cleanNickname,
                    is_host: false,
                    score: 0
                }
            }
        });

    } catch (error) {
        await connection.rollback();

        console.error("Error joinRoom:", error);

        return res.status(500).json({
            success: false,
            message: "Gagal bergabung ke room"
        });

    } finally {
        connection.release();
    }
};
