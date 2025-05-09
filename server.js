require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error(" MONGO_URI not found in .env");
    process.exit(1);
}

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log(" MongoDB connected"))
    .catch(err => console.error(" MongoDB error:", err));

const UserSchema = new mongoose.Schema({ username: String, status: String, socketId: String });
const User = mongoose.model("User", UserSchema);

const ChatSchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    message: String,
    timestamp: { type: Date, default: Date.now },
    delivered: { type: Boolean, default: false }
});
const Chat = mongoose.model("Chat", ChatSchema);

let onlineUsers = {};
let offlineUsers = {};
let activePairs = {};

io.on("connection", (socket) => {
    console.log(" Connected:", socket.id);

    socket.on("goOnline", async (username) => {
        if (!username) return;

        onlineUsers[socket.id] = username;
        delete offlineUsers[socket.id];

        await User.findOneAndUpdate({ username }, { status: "online", socketId: socket.id }, { upsert: true });

        for (const [offlineId, offlineUsername] of Object.entries(offlineUsers)) {
            if (!Object.values(activePairs).some(pair => pair.socketId === socket.id || pair.socketId === offlineId)) {
                activePairs[username] = { partner: offlineUsername, socketId: offlineId };
                activePairs[offlineUsername] = { partner: username, socketId: socket.id };

                io.to(socket.id).emit("matched", offlineUsername);
                io.to(offlineId).emit("matched", username);

                delete offlineUsers[offlineId];
                break;
            }
        }

        const undelivered = await Chat.find({ receiver: username, delivered: false });
        undelivered.forEach(msg => {
            socket.emit("receiveMessage", { sender: msg.sender, message: msg.message });
        });

        await Chat.updateMany({ receiver: username, delivered: false }, { delivered: true });

        io.emit("userList", Object.values(onlineUsers));
    });

    socket.on("goOffline", async (username) => {
        if (!username) return;

        offlineUsers[socket.id] = username;
        delete onlineUsers[socket.id];

        await User.findOneAndUpdate({ username }, { status: "offline" });

        for (const [onlineId, onlineUsername] of Object.entries(onlineUsers)) {
            if (!Object.values(activePairs).some(pair => pair.socketId === socket.id || pair.socketId === onlineId)) {
                activePairs[username] = { partner: onlineUsername, socketId: onlineId };
                activePairs[onlineUsername] = { partner: username, socketId: socket.id };

                io.to(socket.id).emit("matched", onlineUsername);
                io.to(onlineId).emit("matched", username);

                delete onlineUsers[onlineId];
                break;
            }
        }

        io.emit("userList", Object.values(onlineUsers));
    });

    socket.on("sendMessage", async ({ sender, receiver, message }) => {
        if (!sender || !receiver || !message) return;

        const chat = new Chat({ sender, receiver, message, delivered: false });
        await chat.save();

        let receiverSocketId = activePairs[receiver]?.socketId;

        if (!receiverSocketId) {
            receiverSocketId = Object.keys(offlineUsers).find(id => offlineUsers[id] === receiver);
        }

        if (receiverSocketId) {
            io.to(receiverSocketId).emit("receiveMessage", { sender, message });

            await Chat.findByIdAndUpdate(chat._id, { delivered: true });
        }

        const senderSocketId = activePairs[sender]?.socketId || Object.keys(onlineUsers).find(id => onlineUsers[id] === sender);
        if (senderSocketId) {
            io.to(senderSocketId).emit("receiveMessage", { sender, message });
        }
    });

    socket.on("disconnect", async () => {
        const username = onlineUsers[socket.id] || offlineUsers[socket.id];
        if (username) await User.findOneAndUpdate({ username }, { status: "offline" });

        delete onlineUsers[socket.id];
        delete offlineUsers[socket.id];

        for (const [key, val] of Object.entries(activePairs)) {
            if (val.socketId === socket.id) {
                const partner = val.partner;
                delete activePairs[key];
                delete activePairs[partner];
                break;
            }
        }

        io.emit("userList", Object.values(onlineUsers));
        console.log(" Disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(` Server running on port ${PORT}`));
