<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('trading_signals', function (Blueprint $table) {
            $table->id();

            $table->string('instrument', 20)->index();
            $table->enum('action', ['BUY', 'SELL', 'NO_TRADE'])->index();
            $table->enum('timeframe', ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D'])->nullable();

            $table->decimal('entry', 12, 4)->nullable();
            $table->decimal('stop_loss', 12, 4)->nullable();
            $table->decimal('take_profit', 12, 4)->nullable();
            $table->decimal('risk_reward', 6, 2)->nullable();
            $table->unsignedTinyInteger('confidence')->nullable()->comment('0-100');

            $table->decimal('current_price', 12, 4)->nullable();

            $table->text('reasoning')->nullable();
            $table->string('trend_bias', 20)->nullable();

            $table->json('raw_ai_response')->nullable();
            $table->json('indicators_snapshot')->nullable();

            $table->string('telegram_message_id')->nullable();
            $table->timestamp('sent_at')->nullable();

            $table->timestamps();

            $table->index(['instrument', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('trading_signals');
    }
};
