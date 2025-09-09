import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    // In production, get userId from session
    const userId = 'demo-user';
    
    const portfolio = await prisma.portfolio.findFirst({
      where: { userId },
      include: { holdings: true },
    });

    return NextResponse.json(portfolio);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch portfolio' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbol, quantity, avgPrice } = body;
    
    // In production, get userId from session
    const userId = 'demo-user';
    
    let portfolio = await prisma.portfolio.findFirst({
      where: { userId },
    });

    if (!portfolio) {
      portfolio = await prisma.portfolio.create({
        data: { userId },
      });
    }

    const holding = await prisma.holding.create({
      data: {
        portfolioId: portfolio.id,
        symbol,
        quantity,
        avgPrice,
      },
    });

    return NextResponse.json(holding);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to add holding' },
      { status: 500 }
    );
  }
}
