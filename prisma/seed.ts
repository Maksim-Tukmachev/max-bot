import { PrismaClient } from '@prisma/client';

const BRANCHES = ['Воровского', '50 лет ВЛКСМ', 'Строитель'];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const [index, name] of BRANCHES.entries()) {
      await prisma.branch.upsert({
        where: { name },
        create: { name, sortOrder: index },
        update: {},
      });
    }
    console.log(JSON.stringify({ level: 'info', msg: 'seed complete', branches: BRANCHES.length }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
