import { IsInt, IsNotEmpty, IsPositive } from 'class-validator';

export class AddToCartDto {
  @IsInt()
  @IsPositive()
  @IsNotEmpty()
  productId: number;

  @IsInt()
  @IsPositive()
  @IsNotEmpty()
  quantity: number;
}
