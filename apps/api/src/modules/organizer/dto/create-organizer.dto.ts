import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class CreateOrganizerDto {
  @IsNotEmpty()
  @IsString()
  companyName: string;

  @IsOptional()
  @IsString()
  payoutDetails?: string;
}
