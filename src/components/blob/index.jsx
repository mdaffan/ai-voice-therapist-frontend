import React, { useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import vertexShader from "./vertexShader";
import fragmentShader from "./fragmentShader";
import { useFrame } from "@react-three/fiber";




const Blob = forwardRef(({ speed = 0.4 }, ref) => {
  const mesh = useRef();
  const hover = useRef(false);
  const uniforms = useMemo(() => {
    return {
      u_time: { value: 0 },
      u_intensity: { value: 0.3 },
    };
  });

  // Expose underlying THREE.Mesh instance to parent via ref
  useImperativeHandle(ref, () => mesh.current);

  useFrame((state) => {
    const { clock } = state;
    if (mesh.current) {
      // Drive the vertex shader time uniform using external speed prop
      mesh.current.material.uniforms.u_time.value =
        speed * clock.getElapsedTime();
    }
  });
  return (
    <mesh
      ref={mesh}
      scale={1.5}
      position={[0, 0, 0]}
      onPointerOver={() => (hover.current = true)}
      onPointerOut={() => (hover.current = false)}
    >
      <icosahedronGeometry args={[2, 20]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
      />
    </mesh>
  );
});

export default Blob;
