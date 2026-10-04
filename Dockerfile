FROM alpine:3.24

RUN apk add --no-cache git cmake openssl-dev build-base

RUN git clone --depth 1 --recurse-submodules \
    https://github.com/matth-x/MicroOcppSimulator.git /MicroOcppSimulator

RUN cmake -S /MicroOcppSimulator -B /MicroOcppSimulator/build \
    && cmake --build /MicroOcppSimulator/build --target mo_simulator --parallel 2

WORKDIR /MicroOcppSimulator

COPY render-start.sh /usr/local/bin/render-start.sh

EXPOSE 8000

ENTRYPOINT ["sh", "/usr/local/bin/render-start.sh"]
