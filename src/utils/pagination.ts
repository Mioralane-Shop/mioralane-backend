export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Normalizes page and limit values to safe, positive integers.
 */
export function getPaginationParams(page = 1, limit = 10): PaginationParams {
  const safePage = Math.max(parseInt(String(page), 10) || 1, 1);
  const safeLimit = Math.min(
    Math.max(parseInt(String(limit), 10) || 10, 1),
    100,
  );
  return { page: safePage, limit: safeLimit };
}

/**
 * Calculates the TypeORM skip offset for a given page.
 */
export function getSkip({ page, limit }: PaginationParams): number {
  return (page - 1) * limit;
}

/**
 * Wraps raw items and count into a standardized paginated response.
 */
export function buildPaginatedResult<T>(
  items: T[],
  total: number,
  { page, limit }: PaginationParams,
): PaginatedResult<T> {
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
