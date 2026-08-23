import './env';
import { validate } from './config/env.validation';

const startServer = async (): Promise<void> => {
  validate(process.env);

  const [{ connectDB }, { default: createApp }] = await Promise.all([
    import('./data-source'),
    import('./app.module'),
  ]);

  console.log('⏳ Connecting to MongoDB...');
  await connectDB();

  const app = createApp();
  const port = Number(process.env.PORT) || 5000;

  app.listen(port, () => {
    console.log(`🚀 Mioralane backend running on http://localhost:${port}`);
    console.log(`📄 Swagger docs at http://localhost:${port}/api/docs`);
  });
};

startServer().catch((error) => {
  console.error(
    'Failed to start Mioralane backend:',
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
