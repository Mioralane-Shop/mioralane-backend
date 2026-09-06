import * as Joi from 'joi';

/**
 * Environment variable validation schema.
 * Throws an error at startup if required variables are missing or invalid.
 */
export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    PORT: Joi.number().default(3000),
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),
    MONGODB_URI: Joi.string().uri().required(),
    JWT_SECRET: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),
  });

  const { error, value } = schema.validate(config, { allowUnknown: true });

  if (error) {
    throw new Error(`Config validation error: ${error.message}`);
  }

  return value;
};
