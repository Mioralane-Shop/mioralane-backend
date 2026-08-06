import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { CartItem } from './entities/cart-item.entity';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(CartItem)
    private readonly cartItemRepository: Repository<CartItem>,
  ) {}

  // TODO: implement business logic
  getCart() {
    return this.cartItemRepository.find();
  }

  addToCart(addToCartDto: AddToCartDto) {
    return this.cartItemRepository.save(addToCartDto);
  }
}
