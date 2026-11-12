import express from "express";
import { getCategories } from "../controllers/questionController.js";

const router = express.Router();

router.get("/", getCategories);

export default router;