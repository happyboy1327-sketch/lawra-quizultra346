import express from 'express';
import { Mistral } from '@mistralai/mistralai';

const app = express();
app.use(express.json());

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY || 'YOUR_API_KEY' });

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await client.chat.complete({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: message || '안녕하세요! 세상이 멸망했으면 합니다.' }],
    });

    res.json({ result: response.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log('http://localhost:3000 에서 실행 중');
});
