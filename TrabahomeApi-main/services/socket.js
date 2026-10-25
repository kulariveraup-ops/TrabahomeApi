import jwt from "jsonwebtoken";
import { Server } from "socket.io";

let io;

const getJwtSecret = () => process.env.JWT_SECRET || "change-this-secret";

const extractToken = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) return String(authToken);

  const header = socket.handshake?.headers?.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }

  const queryToken = socket.handshake?.query?.token;
  if (queryToken) return String(queryToken);

  return null;
};

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) return next(new Error("Unauthorized"));

      const payload = jwt.verify(token, getJwtSecret());
      if (!payload || !payload.role) {
        return next(new Error("Unauthorized"));
      }
      if (!["homeowner", "worker", "admin"].includes(payload.role)) {
        return next(new Error("Unauthorized"));
      }

      socket.data.userId = payload.id;
      socket.data.role = payload.role;
      return next();
    } catch (error) {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const role = socket.data.role;
    if (!userId || !role) return;

    if (role === "homeowner") {
      socket.join(`homeowner:${userId}`);
    } else if (role === "worker") {
      socket.join(`worker:${userId}`);
    } else if (role === "admin") {
      socket.join("admins");
    }
  });

  return io;
};

export const getIO = () => io;

export const emitToHomeowner = (userId, event, payload) => {
  if (!io || !userId) return;
  io.to(`homeowner:${userId}`).emit(event, payload);
};

export const emitToWorker = (userId, event, payload) => {
  if (!io || !userId) return;
  io.to(`worker:${userId}`).emit(event, payload);
};

export const emitToAdmin = (event, payload) => {
  if (!io) return;
  io.to("admins").emit(event, payload);
};

export const emitToAll = (event, payload) => {
  if (!io) return;
  io.emit(event, payload);
};
