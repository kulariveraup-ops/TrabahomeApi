// routes/chatbot.routes.js
import express from 'express';
import { handleChatbotMessage } from '../controllers/chatbot/chatbot.controller.js';

const router = express.Router();

router.post('/', handleChatbotMessage);
router.post('/message', handleChatbotMessage);

export default router;
