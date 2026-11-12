
import db from "../config/database.js";

// ========================================
// GET SEMUA KATEGORI
// ========================================
export const getCategories = async (req, res) => {
    try {
        const [categories] = await db.query(`
            SELECT
                id,
                name,
                description
            FROM categories
            ORDER BY id ASC
        `);

        res.status(200).json({
            success: true,
            message: "Data kategori berhasil diambil",
            data: categories
        });

    } catch (error) {
        console.error("Error getCategories:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil data kategori"
        });
    }
};


// ========================================
// GET DAFTAR SOAL
// ========================================
export const getQuestions = async (req, res) => {
    try {
        const {
            category_id,
            difficulty,
            limit = 25
        } = req.query;

        const parsedLimit = Number.parseInt(limit, 10);

        if (!Number.isInteger(parsedLimit) ||
            parsedLimit < 1 ||
            parsedLimit > 50) {
            return res.status(400).json({
                success: false,
                message: "Limit harus berupa angka 1 sampai 50"
            });
        }

        let sql = `
            SELECT
                id,
                category_id,
                question_text,
                difficulty
            FROM questions
            WHERE 1 = 1
        `;

        const params = [];

        if (category_id !== undefined) {
            const categoryId = Number.parseInt(category_id, 10);

            if (!Number.isInteger(categoryId) || categoryId < 1) {
                return res.status(400).json({
                    success: false,
                    message: "category_id tidak valid"
                });
            }

            sql += " AND category_id = ?";
            params.push(categoryId);
        }

        if (difficulty !== undefined) {
            const allowedDifficulty = ["easy", "medium", "hard"];

            if (!allowedDifficulty.includes(difficulty)) {
                return res.status(400).json({
                    success: false,
                    message: "Difficulty harus easy, medium, atau hard"
                });
            }

            sql += " AND difficulty = ?";
            params.push(difficulty);
        }

        sql += " ORDER BY id ASC LIMIT ?";
        params.push(parsedLimit);

        const [questions] = await db.execute(sql, params);

        if (questions.length === 0) {
            return res.status(200).json({
                success: true,
                message: "Tidak ada soal ditemukan",
                total: 0,
                data: []
            });
        }

        const questionIds = questions.map(question => question.id);

        const placeholders = questionIds.map(() => "?").join(",");

        const [options] = await db.execute(
            `
                SELECT
                    question_id,
                    id,
                    option_text
                FROM question_options
                WHERE question_id IN (${placeholders})
                ORDER BY question_id ASC, id ASC
            `,
            questionIds
        );

        const result = questions.map(question => ({
            ...question,
            options: options
                .filter(option => option.question_id === question.id)
                .map(option => ({
                    id: option.id,
                    option_text: option.option_text
                }))
        }));

        res.status(200).json({
            success: true,
            message: "Bank soal berhasil diambil",
            total: result.length,
            data: result
        });

    } catch (error) {
        console.error("Error getQuestions:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil bank soal"
        });
    }
};
