
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

                const cleanRoomCode = String(room_code).trim().toUpperCase();

                // Validasi pemain dan room di database
                const [players] = await db.execute(
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
                    WHERE rp.id = ?
                    AND gr.room_code = ?
                    AND rp.is_connected = 1`,
                    [player_id, cleanRoomCode]
                );

                if (players.length === 0) {
                    socket.emit("room_error", {
                        message: "Pemain atau room tidak ditemukan"
                    });
                    return;
                }

                const player = players[0];

                if (player.status !== "waiting") {
                    socket.emit("room_error", {
                        message: "Room tidak sedang menunggu pemain"
                    });
                    return;
                }

                // Hubungkan socket dengan pemain
                await db.execute(
                    `UPDATE room_players
                     SET socket_id = ?
                     WHERE id = ?`,
                    [socket.id, player.id]
                );

                // Masukkan socket ke dalam room Socket.IO
                socket.join(cleanRoomCode);

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

                // Ambil daftar pemain terbaru
                const [roomPlayers] = await db.execute(
                    `SELECT id, nickname, score, is_host
                     FROM room_players
                     WHERE room_id = ?
                     AND is_connected = 1
                     ORDER BY joined_at ASC`,
                    [player.room_id]
                );

                // Kirim daftar pemain ke semua anggota room
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
                    await db.execute(
                        `UPDATE room_players
                         SET is_connected = 0,
                             socket_id = NULL
                         WHERE id = ?
                         AND socket_id = ?`,
                        [playerId, socket.id]
                    );

                    console.log(
                        "Pemain terputus dari room: " + roomCode
                    );

                    if (roomCode) {
                        const [roomPlayers] = await db.execute(
                            `SELECT id, nickname, score, is_host
                             FROM room_players
                             WHERE room_id = (
                                 SELECT id FROM game_rooms
                                 WHERE room_code = ?
                             )
                             AND is_connected = 1
                             ORDER BY joined_at ASC`,
                            [roomCode]
                        );

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
