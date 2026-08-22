import {
  Column,
  CreateDateColumn,
  Entity,
  Check,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Category } from '@/modules/categories/entities/category.entity';

@Check(`"stock" >= 0 AND "stock" = FLOOR("stock")`)
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'simple-array', nullable: true })
  images: string[];

  @Column({ default: true })
  isActive: boolean;

  @ManyToOne(() => Category, { nullable: true, onDelete: 'SET NULL' })
  category: Category;

  @Column({ nullable: true })
  categoryId: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
