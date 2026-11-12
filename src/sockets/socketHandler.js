
import db from "../config/database.js";

export default function registerSocketHandlers(io) {
    io.on("connection", (socket) => {
        console.log("Pemain terhubung: " + socket.id);

        // ========================================
        // PEMAIN BERGABUNG KE ROOM
        // ========================================
        socket.on("join_room", async (data) => {
            try {
                const { room_code, player_id } = data || {};

                if (!room_code || !player_id) {
                    socket.emit("room_error", {
                        message: "Kode room dan player ID wajib diisi"
                    });
                    return;
                }

                const cleanRoomCode = String(room_code)
                    .trim()
                    .toUpperCase();

                const parsedPlayerId = Number(player_id);

                if (!Number.isInteger(parsedPlayerId) || parsedPlayerId < 1) {
                    socket.emit("room_error", {
                        message: "Player ID tidak valid"
                    });
                    return;
                }

                // Validasi pemain dan room di PostgreSQL.
                const playerResult = await db.query(
                    `SELECT
                        rp.id,
                        rp.room_id,
                        rp.nickname,
                        rp.score,
                        rp.is_host,
                        gr.room_code,
                        gr.status
                    FROM room_players rp
                    JOIN game_rooms gr ON gr.id = rp.room_id
                    WHERE rp.id = $1
                    AND gr.room_code = $2
                    AND rp.is_connected = TRUE`,
                    [parsedPlayerId, cleanRoomCode]
                );

                if (playerResult.rows.length === 0) {
                    socket.emit("room_error", {
                        message: "Pemain atau room tidak ditemukan"
                    });
                    return;
                }

                const player = playerResult.rows[0];

                if (player.status !== "waiting") {
                    socket.emit("room_error", {
                        message: "Room tidak sedang menunggu pemain"
                    });
                    return;
                }

                // Hubungkan socket dengan pemain.
                await db.query(
                    `UPDATE room_players
                     SET socket_id = $1
                     WHERE id = $2`,
                    [socket.id, player.id]
                );

                // Masukkan socket ke room Socket.IO.
                await socket.join(cleanRoomCode);

                socket.data.playerId = player.id;
                socket.data.roomCode = cleanRoomCode;

                socket.emit("room_joined", {
                    success: true,
                    message: "Berhasil terhubung ke room",
                    data: {
                        player_id: player.id,
                        room_code: cleanRoomCode,
                        nickname: player.nickname,
                        is_host: Boolean(player.is_host)
                    }
                });

                // Ambil daftar pemain terbaru.
                const roomPlayersResult = await db.query(
                    `SELECT
                        id,
                        nickname,
                        score,
                        is_host
                    FROM room_players
                    WHERE room_id = $1
                    AND is_connected = TRUE
                    ORDER BY joined_at ASC`,
                    [player.room_id]
                );

                const roomPlayers = roomPlayersResult.rows;

                // Kirim daftar pemain ke semua anggota room.
                io.to(cleanRoomCode).emit("room_players_updated", {
                    total_players: roomPlayers.length,
                    players: roomPlayers
                });

                console.log(
                    player.nickname + " masuk ke room " + cleanRoomCode
                );

            } catch (error) {
                console.error("Error join_room:", error);

                socket.emit("room_error", {
                    message: "Gagal bergabung ke room"
                });
            }
        });


        // ========================================
        // PEMAIN TERPUTUS
        // ========================================
        socket.on("disconnect", async () => {
            try {
                const playerId = socket.data.playerId;
                const roomCode = socket.data.roomCode;

                if (playerId) {
                    // Update status pemain yang terputus.
                    const updateResult = await db.query(
                        `UPDATE room_players
                         SET is_connected = FALSE,
                             socket_id = NULL
                         WHERE id = $1
                         AND socket_id = $2
                         RETURNING room_id`,
                        [playerId, socket.id]
                    );

                    console.log(
                        "Pemain terputus dari room: " + roomCode
                    );

                    if (roomCode && updateResult.rows.length > 0) {
                        const roomId = updateResult.rows[0].room_id;

                        const roomPlayersResult = await db.query(
                            `SELECT
                                id,
                                nickname,
                                score,
                                is_host
                             FROM room_players
                             WHERE room_id = $1
                             AND is_connected = TRUE
                             ORDER BY joined_at ASC`,
                            [roomId]
                        );

                        const roomPlayers = roomPlayersResult.rows;

                        io.to(roomCode).emit("room_players_updated", {
                            total_players: roomPlayers.length,
                            players: roomPlayers
                        });
                    }
                }

            } catch (error) {
                console.error("Error disconnect:", error);
            }
        });
    });
}
