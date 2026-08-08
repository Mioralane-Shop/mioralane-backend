import './env';
import { connectDB } from './data-source';
import createApp from './app.module';

const startServer = async (): Promise<void> => {
  console.log('⏳ Connecting to MongoDB...');
  await connectDB();

  const app = createApp();
  const port = Number(process.env.PORT) || 5000;

  app.listen(port, () => {
    console.log(`🚀 Mioralane backend running on http://localhost:${port}`);
    console.log(`📄 Swagger docs at http://localhost:${port}/api/docs`);
  });
};

startServer();
