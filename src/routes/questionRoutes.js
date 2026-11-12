
import express from "express";

import {
    getCategories,
    getQuestions
} from "../controllers/questionController.js";

const router = express.Router();

// GET /api/categories
router.get("/categories", getCategories);

// GET /api/questions
router.get("/questions", getQuestions);

export default router;
