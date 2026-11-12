
import express from "express";

import {
    createRoom,
    joinRoom
} from "../controllers/roomController.js";

const router = express.Router();

// Membuat room baru
router.post("/", createRoom);

// Bergabung ke room
router.post("/join", joinRoom);

export default router;
