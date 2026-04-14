import { PokerTable, TableConfig } from './PokerTable';
import { OmahaTable } from './variants/OmahaTable';
import { ShortDeckTable } from './variants/ShortDeckTable';
import { FiveCardDrawTable } from './variants/FiveCardDrawTable';
import { SevenStudTable } from './variants/SevenStudTable';
import { PineappleTable } from './variants/PineappleTable';
import { BadugiTable } from './variants/BadugiTable';
import { VariantType } from './variants/PokerVariant';
import { v4 as uuidv4 } from 'uuid';

export interface TableListItem {
  tableId: string;
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  playerCount: number;
  maxSeats: number;
  ante: number;
  variant: VariantType;
  variantName: string;
}

export class TableManager {
  private tables: Map<string, PokerTable> = new Map();

  constructor() {
    this.createDefaultTables();
  }

  private createDefaultTables(): void {
    // 2 Hold'em tables
    this.createVariantTable({
      tableName: "Beginner's Table",
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'texas-holdem');

    this.createVariantTable({
      tableName: 'The Shark Tank',
      smallBlind: 100,
      bigBlind: 200,
      ante: 0,
      minBuyIn: 20000,
    }, 'texas-holdem');

    // 1 Omaha table
    this.createVariantTable({
      tableName: 'Omaha Action',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      minBuyIn: 10000,
    }, 'omaha');

    // 1 Short Deck table
    this.createVariantTable({
      tableName: 'Short Deck Showdown',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      minBuyIn: 10000,
    }, 'short-deck');

    // 1 Five Card Draw table
    this.createVariantTable({
      tableName: 'Draw Poker Lounge',
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'five-card-draw');

    // 1 Seven Card Stud table
    this.createVariantTable({
      tableName: 'Stud Poker Club',
      smallBlind: 25,
      bigBlind: 50,
      ante: 5,
      minBuyIn: 5000,
    }, 'seven-card-stud');

    // ─── Additional variants ───
    this.createVariantTable({
      tableName: '5-Card Omaha',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      minBuyIn: 10000,
    }, 'omaha-5');

    this.createVariantTable({
      tableName: '6-Card Omaha',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      minBuyIn: 10000,
    }, 'omaha-6');

    this.createVariantTable({
      tableName: 'Stud Hi-Lo (Stud 8)',
      smallBlind: 25,
      bigBlind: 50,
      ante: 5,
      minBuyIn: 5000,
    }, 'seven-card-stud-hi-lo');

    this.createVariantTable({
      tableName: 'Pineapple Lounge',
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'pineapple');

    this.createVariantTable({
      tableName: 'Crazy Pineapple',
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'crazy-pineapple');

    this.createVariantTable({
      tableName: 'Badugi Room',
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'badugi');

    this.createVariantTable({
      tableName: 'Razz Lowball',
      smallBlind: 25,
      bigBlind: 50,
      ante: 5,
      minBuyIn: 5000,
    }, 'razz');

    this.createVariantTable({
      tableName: 'Triple Draw 2-7',
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 5000,
    }, 'triple-draw');

    this.createVariantTable({
      tableName: 'Omaha Hi-Lo',
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      minBuyIn: 10000,
    }, 'omaha-hi-lo');
  }

  createTable(config: Omit<TableConfig, 'tableId'>): string {
    const tableId = uuidv4();
    const fullConfig: TableConfig = { ...config, tableId };
    const table = new PokerTable(fullConfig);
    this.tables.set(tableId, table);
    return tableId;
  }

  createVariantTable(config: Omit<TableConfig, 'tableId'>, variant: VariantType): string {
    const tableId = uuidv4();
    const fullConfig: TableConfig = { ...config, tableId };
    let table: PokerTable;

    switch (variant) {
      case 'omaha':
        table = new OmahaTable(fullConfig, false, 4);
        break;
      case 'omaha-hi-lo':
        table = new OmahaTable(fullConfig, true, 4);
        break;
      case 'omaha-5':
        table = new OmahaTable(fullConfig, false, 5);
        break;
      case 'omaha-6':
        table = new OmahaTable(fullConfig, false, 6);
        break;
      case 'short-deck':
        table = new ShortDeckTable(fullConfig);
        break;
      case 'five-card-draw':
        table = new FiveCardDrawTable(fullConfig, false);
        break;
      case 'triple-draw':
        table = new FiveCardDrawTable(fullConfig, true);
        break;
      case 'badugi':
        table = new BadugiTable(fullConfig);
        break;
      case 'seven-card-stud':
        table = new SevenStudTable(fullConfig, false, false);
        break;
      case 'seven-card-stud-hi-lo':
        table = new SevenStudTable(fullConfig, false, true);
        break;
      case 'razz':
        table = new SevenStudTable(fullConfig, true, false);
        break;
      case 'pineapple':
        table = new PineappleTable(fullConfig, false);
        break;
      case 'crazy-pineapple':
        table = new PineappleTable(fullConfig, true);
        break;
      case 'mixed-horse':
        // HORSE (Hold'em, Omaha H/L, Razz, Stud, Stud H/L) — not yet implemented
        // Fall back to Texas Hold'em rather than silently using wrong variant
        console.warn('[TableManager] mixed-horse is not implemented; defaulting to Texas Hold\'em');
        table = new PokerTable(fullConfig);
        break;
      default:
        table = new PokerTable(fullConfig);
        break;
    }

    this.tables.set(tableId, table);
    return tableId;
  }

  getTable(tableId: string): PokerTable | undefined {
    return this.tables.get(tableId);
  }

  removeTable(tableId: string): boolean {
    return this.tables.delete(tableId);
  }

  getTableList(): TableListItem[] {
    const list: TableListItem[] = [];
    for (const [tableId, table] of this.tables) {
      // Determine variant info from table type
      let variant: VariantType = 'texas-holdem';
      let variantName = "Texas Hold'em";
      let maxSeats = 9;

      // Order matters: BadugiTable extends FiveCardDrawTable, so check
      // subclasses first.
      if (table instanceof OmahaTable) {
        const omTable = table as OmahaTable;
        variant = (omTable.variantId as VariantType) || omTable.variant.type;
        variantName = omTable.variantName || omTable.variant.name;
      } else if (table instanceof ShortDeckTable) {
        const sdTable = table as ShortDeckTable;
        variant = sdTable.variant.type;
        variantName = sdTable.variant.name;
      } else if (table instanceof BadugiTable) {
        variant = 'badugi';
        variantName = 'Badugi';
        maxSeats = 6;
      } else if (table instanceof FiveCardDrawTable) {
        const fdTable = table as FiveCardDrawTable;
        variant = fdTable.variant.type;
        variantName = fdTable.variant.name;
        maxSeats = 6;
      } else if (table instanceof SevenStudTable) {
        const ssTable = table as SevenStudTable;
        variant = (ssTable.variantId as VariantType) || ssTable.variant.type;
        variantName = ssTable.variantName || ssTable.variant.name;
        maxSeats = 8;
      } else if (table instanceof PineappleTable) {
        const pTable = table as PineappleTable;
        variant = (pTable.variantId as VariantType) || 'pineapple';
        variantName = pTable.variantName || 'Pineapple';
      }

      list.push({
        tableId,
        tableName: table.config.tableName,
        smallBlind: table.config.smallBlind,
        bigBlind: table.config.bigBlind,
        minBuyIn: table.config.minBuyIn,
        playerCount: table.getOccupiedSeatCount(),
        maxSeats,
        ante: table.config.ante,
        variant,
        variantName,
      });
    }
    return list;
  }

  createHeadsUpTable(name: string): string {
    const tableId = uuidv4();
    const config: TableConfig = {
      tableId,
      tableName: name,
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
      minBuyIn: 1000,
    };
    const table = new PokerTable(config);
    this.tables.set(tableId, table);
    return tableId;
  }

  createQuickTable(name: string, maxPlayers: number, smallBlind: number, bigBlind: number, minBuyIn: number, variant?: VariantType): string {
    if (variant && variant !== 'texas-holdem') {
      return this.createVariantTable({
        tableName: name,
        smallBlind,
        bigBlind,
        ante: 0,
        minBuyIn,
      }, variant);
    }

    const tableId = uuidv4();
    const config: TableConfig = {
      tableId,
      tableName: name,
      smallBlind,
      bigBlind,
      ante: 0,
      minBuyIn,
    };
    const table = new PokerTable(config);
    this.tables.set(tableId, table);
    return tableId;
  }

  getAllTableIds(): string[] {
    return [...this.tables.keys()];
  }

  /** Find a table by invite code (first 8 chars of its UUID, lowercased). */
  getTableByInviteCode(code: string): { tableId: string; table: PokerTable } | null {
    for (const [tableId, table] of this.tables) {
      if (tableId.slice(0, 8).toLowerCase() === code.toLowerCase()) {
        return { tableId, table };
      }
    }
    return null;
  }
}
