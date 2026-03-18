import { Context } from 'koishi'
import { Config } from '.'
// import start
import { apply as backend } from './plugins/backend'
import { apply as command } from './plugins/command'
// import end

export async function plugins(ctx: Context, parent: Config) {
    type Command = (ctx: Context, config: Config) => PromiseLike<void> | void

    const middlewares: Command[] =
        // middleware start
        [backend, command] // middleware end

    for (const middleware of middlewares) {
        await middleware(ctx, parent)
    }
}
