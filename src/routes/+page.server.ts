export const actions = {
    ws: (event) => {
        return {
            url: websockets.use(event, (socket) => {
                setInterval(() => {
                    socket.send("Hello World")
                }, 1000)
            })
        }
    }
}
