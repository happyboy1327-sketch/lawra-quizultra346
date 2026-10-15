// 서버 오류 플래그: serverError: true
import express from "express";

const app = express();
app.use(express.json());

app.use((req, res) => {
  res.status(500).json({ 
    error: "서버가 파괴되었습니다.", 
    serverError: true 
  });
});

export default app;
